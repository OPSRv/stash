use crate::modules::translator::{
    engine,
    repo::{TranslationRow, TranslationsRepo},
};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone)]
pub struct Translation {
    pub original: String,
    pub translated: String,
    pub from: String,
    pub to: String,
}

pub struct TranslatorSettings {
    pub enabled: bool,
    pub target: String,
    pub min_chars: usize,
}

/// Shared state: last-translated cache (skip repeats), per-target preferences.
/// Kept simple — purging one entry when capacity hits 64 is enough for a
/// menubar tool where the cache exists to dedupe bursty copies, not to act
/// as a persistent store.
pub struct TranslatorState {
    pub settings: Mutex<TranslatorSettings>,
    pub cache: Mutex<std::collections::HashMap<String, (Translation, Instant)>>,
    pub repo: Mutex<Option<TranslationsRepo>>,
}

const CACHE_TTL: Duration = Duration::from_secs(60 * 10);
const CACHE_MAX: usize = 64;

impl TranslatorState {
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(TranslatorSettings {
                enabled: false,
                target: "uk".into(),
                min_chars: 6,
            }),
            cache: Mutex::new(std::collections::HashMap::new()),
            repo: Mutex::new(None),
        }
    }

    pub fn with_repo(mut self, repo: TranslationsRepo) -> Self {
        self.repo = Mutex::new(Some(repo));
        self
    }

    /// Apply a translation if settings are enabled, the input looks foreign
    /// (ASCII-heavy), and it is long enough to bother with. Result is cached
    /// by text hash so flipping back to an older clipboard item does not
    /// re-hit the network.
    pub fn auto_translate(&self, text: &str) -> Option<Translation> {
        let (enabled, target, min_chars) = {
            let s = self.settings.lock().unwrap();
            (s.enabled, s.target.clone(), s.min_chars)
        };
        if !enabled {
            tracing::debug!("translator skip: disabled");
            return None;
        }
        let trimmed = text.trim();
        let len = trimmed.chars().count();
        if len < min_chars {
            tracing::debug!(%len, %min_chars, "translator skip: too short");
            return None;
        }
        if !engine::is_mostly_ascii_letters(trimmed) {
            tracing::debug!("translator skip: not ASCII-heavy");
            return None;
        }
        if target == "en" {
            return None;
        }
        if let Some(hit) = self.cache.lock().unwrap().get(trimmed) {
            if hit.1.elapsed() < CACHE_TTL {
                tracing::debug!("translator cache hit");
                return Some(hit.0.clone());
            }
        }
        tracing::info!(%target, chars = len, "translator: calling google");
        let translated = match engine::translate_via_google(trimmed, "auto", &target) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, "translator: google call failed");
                return None;
            }
        };
        if translated.trim() == trimmed {
            tracing::debug!("translator skip: identity translation");
            return None;
        }
        let t = Translation {
            original: trimmed.to_string(),
            translated,
            from: "auto".into(),
            to: target,
        };
        {
            let mut cache = self.cache.lock().unwrap();
            if cache.len() >= CACHE_MAX {
                // Evict one arbitrary entry — cheaper than an LRU for our scale.
                if let Some(k) = cache.keys().next().cloned() {
                    cache.remove(&k);
                }
            }
            cache.insert(trimmed.to_string(), (t.clone(), Instant::now()));
        }
        // Persist to the Translations tab history. Best-effort — a DB error
        // must not block the banner/notification.
        if let Ok(mut guard) = self.repo.lock() {
            if let Some(repo) = guard.as_mut() {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                if let Err(e) = repo.insert(&t.original, &t.translated, &t.from, &t.to, now) {
                    tracing::warn!(error = %e, "translator: history insert failed");
                }
            }
        }
        Some(t)
    }
}

impl Default for TranslatorState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn translator_run(
    text: String,
    from: Option<String>,
    to: String,
) -> Result<Translation, String> {
    let from_c = from.unwrap_or_else(|| "auto".into());
    let to_c = to.clone();
    let text_c = text.clone();
    let from_for_move = from_c.clone();
    let translated = tauri::async_runtime::spawn_blocking(move || {
        engine::translate_via_google(&text_c, &from_for_move, &to_c)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Translation {
        original: text,
        translated,
        from: from_c,
        to,
    })
}

fn to_str<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn translator_list(
    state: tauri::State<'_, std::sync::Arc<TranslatorState>>,
    limit: Option<usize>,
) -> Result<Vec<TranslationRow>, String> {
    let mut guard = state.repo.lock().unwrap();
    let repo = guard
        .as_mut()
        .ok_or_else(|| "translator repo not initialised".to_string())?;
    repo.list(limit.unwrap_or(200)).map_err(to_str)
}

#[tauri::command]
pub fn translator_search(
    state: tauri::State<'_, std::sync::Arc<TranslatorState>>,
    query: String,
) -> Result<Vec<TranslationRow>, String> {
    let mut guard = state.repo.lock().unwrap();
    let repo = guard
        .as_mut()
        .ok_or_else(|| "translator repo not initialised".to_string())?;
    if query.trim().is_empty() {
        return repo.list(200).map_err(to_str);
    }
    repo.search(&query, 200).map_err(to_str)
}

#[tauri::command]
pub fn translator_delete(
    state: tauri::State<'_, std::sync::Arc<TranslatorState>>,
    id: i64,
) -> Result<(), String> {
    let mut guard = state.repo.lock().unwrap();
    let repo = guard
        .as_mut()
        .ok_or_else(|| "translator repo not initialised".to_string())?;
    repo.delete(id).map_err(to_str)
}

#[tauri::command]
pub fn translator_clear(
    state: tauri::State<'_, std::sync::Arc<TranslatorState>>,
) -> Result<usize, String> {
    let mut guard = state.repo.lock().unwrap();
    let repo = guard
        .as_mut()
        .ok_or_else(|| "translator repo not initialised".to_string())?;
    repo.clear().map_err(to_str)
}

#[tauri::command]
pub fn translator_set_settings(
    state: tauri::State<'_, std::sync::Arc<TranslatorState>>,
    enabled: bool,
    target: String,
    min_chars: Option<usize>,
) -> Result<(), String> {
    let mut s = state.settings.lock().unwrap();
    s.enabled = enabled;
    s.target = if target.is_empty() {
        "uk".into()
    } else {
        target
    };
    if let Some(n) = min_chars {
        s.min_chars = n.max(1);
    }
    // Clearing the cache means settings changes take immediate effect even
    // for repeated clipboard content.
    state.cache.lock().unwrap().clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::translator::repo::TranslationsRepo;
    use rusqlite::Connection;

    fn state_with_repo() -> TranslatorState {
        let repo = TranslationsRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        TranslatorState::new().with_repo(repo)
    }

    #[test]
    fn with_repo_attaches_and_persists_via_direct_insert() {
        let state = state_with_repo();
        {
            let mut g = state.repo.lock().unwrap();
            let r = g.as_mut().unwrap();
            r.insert("Hello there", "Привіт там", "auto", "uk", 100)
                .unwrap();
        }
        let list = state
            .repo
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .list(10)
            .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].original, "Hello there");
        assert_eq!(list[0].translated, "Привіт там");
        assert_eq!(list[0].to_lang, "uk");
    }

    #[test]
    fn auto_translate_skips_when_disabled_even_with_repo() {
        let state = state_with_repo();
        // enabled defaults to false
        let out = state.auto_translate("Hello there friend");
        assert!(out.is_none());
        let list = state
            .repo
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .list(10)
            .unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn auto_translate_skips_short_text() {
        let state = state_with_repo();
        {
            let mut s = state.settings.lock().unwrap();
            s.enabled = true;
            s.min_chars = 10;
        }
        assert!(state.auto_translate("short").is_none());
    }
}
