//! Provider factory — reads the active AI configuration from the
//! `settings.json` file the AI module writes, pairs it with a key
//! from the `com.stash.ai` secret store, and returns a boxed
//! `LlmClient`. Keeps the telegram assistant independent of the
//! specific provider.

use std::path::Path;
use std::sync::Arc;

use super::anthropic::AnthropicClient;
use super::google::GoogleClient;
use super::openai::OpenAiClient;
use super::{LlmClient, LlmError};
use crate::modules::telegram::keyring::SecretStore;

/// Active AI provider. Mirrors the frontend `AiProvider` type; keep
/// the string forms in sync with `src/settings/store.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiProvider {
    OpenAi,
    Anthropic,
    Google,
    Custom,
}

impl AiProvider {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "openai" => Some(Self::OpenAi),
            "anthropic" => Some(Self::Anthropic),
            "google" => Some(Self::Google),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }

    /// Account name used by the `com.stash.ai` keyring entries.
    pub fn key_account(&self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Google => "google",
            Self::Custom => "custom",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiConfig {
    pub provider: AiProvider,
    pub model: String,
    pub base_url: Option<String>,
    /// Fallback API key read from `settings.json → aiApiKeys[<provider>]`.
    /// Used when the OS keyring is unavailable (unsigned dev builds on
    /// macOS silently drop Keychain writes) — the FE already stores the
    /// key in settings.json for its own needs, so reusing it keeps the
    /// dev loop working with no extra configuration.
    pub api_key_fallback: Option<String>,
}

/// Read the active AI config from `settings.json`. Missing file or
/// missing keys fall back to sensible defaults so the caller can
/// still get an actionable error (missing key) rather than a parse
/// failure.
pub fn read_config(settings_path: &Path) -> Result<AiConfig, LlmError> {
    let raw = std::fs::read_to_string(settings_path).unwrap_or_else(|_| "{}".to_string());
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| LlmError::BadResponse(format!("settings.json parse: {e}")))?;
    let provider_str = value
        .get("aiProvider")
        .and_then(|v| v.as_str())
        .unwrap_or("openai");
    let provider = AiProvider::parse(provider_str).ok_or_else(|| {
        LlmError::BadResponse(format!("unknown aiProvider '{provider_str}' in settings"))
    })?;
    let model = value
        .get("aiModel")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let base_url = value
        .get("aiBaseUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Security: plaintext `aiApiKeys` fallback from the settings store is only
    // honoured in debug builds (unsigned dev binaries can lose the Keychain
    // ACL after re-signing). In release the Keychain is the sole source.
    let api_key_fallback = if cfg!(debug_assertions) {
        value
            .get("aiApiKeys")
            .and_then(|m| m.get(provider.key_account()))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    } else {
        None
    };
    Ok(AiConfig {
        provider,
        model,
        base_url,
        api_key_fallback,
    })
}

const OPENAI_DEFAULT_BASE: &str = "https://api.openai.com/v1";
const ANTHROPIC_DEFAULT_BASE: &str = "https://api.anthropic.com/v1";
const GOOGLE_DEFAULT_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Construct a provider-specific `LlmClient`. Callers must supply
/// the shared AI `SecretStore` (pointing at `com.stash.ai`); missing
/// key → `LlmError::Auth`.
pub fn build_client(
    cfg: &AiConfig,
    ai_secrets: &Arc<dyn SecretStore>,
) -> Result<Box<dyn LlmClient>, LlmError> {
    let key = ai_secrets
        .get(cfg.provider.key_account())
        .map_err(|e| LlmError::BadResponse(format!("keyring: {e}")))?
        .or_else(|| cfg.api_key_fallback.clone())
        .ok_or(LlmError::Auth)?;

    if cfg.model.trim().is_empty() {
        return Err(LlmError::BadResponse(
            "No model configured — set one in Stash → AI.".into(),
        ));
    }

    match cfg.provider {
        AiProvider::OpenAi => {
            let base = cfg
                .base_url
                .clone()
                .unwrap_or_else(|| OPENAI_DEFAULT_BASE.to_string());
            Ok(Box::new(OpenAiClient::new(base, key, cfg.model.clone())))
        }
        AiProvider::Custom => {
            let base = cfg
                .base_url
                .clone()
                .ok_or_else(|| LlmError::BadResponse("Custom provider needs a base URL.".into()))?;
            Ok(Box::new(OpenAiClient::new(base, key, cfg.model.clone())))
        }
        AiProvider::Anthropic => {
            let base = cfg
                .base_url
                .clone()
                .unwrap_or_else(|| ANTHROPIC_DEFAULT_BASE.to_string());
            Ok(Box::new(AnthropicClient::new(base, key, cfg.model.clone())))
        }
        AiProvider::Google => {
            let base = cfg
                .base_url
                .clone()
                .unwrap_or_else(|| GOOGLE_DEFAULT_BASE.to_string());
            Ok(Box::new(GoogleClient::new(base, key, cfg.model.clone())))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::keyring::MemStore;

    fn secrets_with(account: &str, key: &str) -> Arc<dyn SecretStore> {
        let store: Arc<dyn SecretStore> = Arc::new(MemStore::new());
        store.set(account, key).unwrap();
        store
    }

    #[test]
    fn read_config_defaults_to_openai_when_file_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = read_config(&tmp.path().join("settings.json")).unwrap();
        assert_eq!(cfg.provider, AiProvider::OpenAi);
        assert_eq!(cfg.model, "");
    }

    #[test]
    fn read_config_parses_all_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"aiProvider":"anthropic","aiModel":"claude-3-5-sonnet-latest","aiBaseUrl":null}"#,
        )
        .unwrap();
        let cfg = read_config(&path).unwrap();
        assert_eq!(cfg.provider, AiProvider::Anthropic);
        assert_eq!(cfg.model, "claude-3-5-sonnet-latest");
        assert!(cfg.base_url.is_none());
        assert!(cfg.api_key_fallback.is_none());
    }

    #[test]
    fn read_config_surfaces_api_key_from_settings_map() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"aiProvider":"openai","aiModel":"gpt-4o-mini","aiApiKeys":{"openai":"sk-from-file"}}"#,
        )
        .unwrap();
        let cfg = read_config(&path).unwrap();
        assert_eq!(cfg.api_key_fallback.as_deref(), Some("sk-from-file"));
    }

    #[test]
    fn build_client_uses_settings_fallback_when_keyring_empty() {
        let secrets: Arc<dyn SecretStore> = Arc::new(MemStore::new());
        let cfg = AiConfig {
            provider: AiProvider::OpenAi,
            model: "gpt-4o-mini".into(),
            base_url: None,
            api_key_fallback: Some("sk-from-file".into()),
        };
        assert!(build_client(&cfg, &secrets).is_ok());
    }

    #[test]
    fn read_config_surfaces_unknown_provider() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        std::fs::write(&path, r#"{"aiProvider":"cohere"}"#).unwrap();
        match read_config(&path) {
            Err(LlmError::BadResponse(m)) => assert!(m.contains("cohere")),
            other => panic!("expected BadResponse, got {other:?}"),
        }
    }

    fn err(r: Result<Box<dyn LlmClient>, LlmError>) -> LlmError {
        match r {
            Ok(_) => panic!("expected error, got Ok(client)"),
            Err(e) => e,
        }
    }

    #[test]
    fn build_client_without_key_returns_auth() {
        let secrets: Arc<dyn SecretStore> = Arc::new(MemStore::new());
        let cfg = AiConfig {
            provider: AiProvider::OpenAi,
            model: "gpt-4o-mini".into(),
            base_url: None,
            api_key_fallback: None,
        };
        assert_eq!(err(build_client(&cfg, &secrets)), LlmError::Auth);
    }

    #[test]
    fn build_client_openai_with_key_builds() {
        let secrets = secrets_with("openai", "sk-test");
        let cfg = AiConfig {
            provider: AiProvider::OpenAi,
            model: "gpt-4o-mini".into(),
            base_url: None,
            api_key_fallback: None,
        };
        assert!(build_client(&cfg, &secrets).is_ok());
    }

    #[test]
    fn build_client_anthropic_with_key_builds() {
        let secrets = secrets_with("anthropic", "sk-ant-test");
        let cfg = AiConfig {
            provider: AiProvider::Anthropic,
            model: "claude-3-5-sonnet-latest".into(),
            base_url: None,
            api_key_fallback: None,
        };
        assert!(build_client(&cfg, &secrets).is_ok());
    }

    #[test]
    fn build_client_custom_requires_base_url() {
        let secrets = secrets_with("custom", "key");
        let cfg = AiConfig {
            provider: AiProvider::Custom,
            model: "any".into(),
            base_url: None,
            api_key_fallback: None,
        };
        match err(build_client(&cfg, &secrets)) {
            LlmError::BadResponse(m) => assert!(m.to_lowercase().contains("base url")),
            e => panic!("expected BadResponse, got {e}"),
        }
    }

    #[test]
    fn build_client_rejects_empty_model() {
        let secrets = secrets_with("openai", "k");
        let cfg = AiConfig {
            provider: AiProvider::OpenAi,
            model: "".into(),
            base_url: None,
            api_key_fallback: None,
        };
        match err(build_client(&cfg, &secrets)) {
            LlmError::BadResponse(m) => assert!(m.to_lowercase().contains("model")),
            e => panic!("expected BadResponse, got {e}"),
        }
    }

    #[test]
    fn build_client_google_with_key_builds() {
        let secrets = secrets_with("google", "k");
        let cfg = AiConfig {
            provider: AiProvider::Google,
            model: "gemini-1.5-flash".into(),
            base_url: None,
            api_key_fallback: None,
        };
        assert!(build_client(&cfg, &secrets).is_ok());
    }
}
