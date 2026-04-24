//! Small wrapper around wttr.in — text weather for a city name.
//!
//! wttr.in takes an arbitrary location path, supports locale via the
//! `lang=` query, and lets us ask for just the one-line summary via
//! `?format=...`. No API key, no dependency, graceful ASCII output
//! that renders identically in Telegram, CLI, and the assistant reply.

use std::time::Duration;

/// Shape the URL so wttr returns a compact human-readable block: current
/// temperature, "feels like", wind, precipitation, and a tiny forecast.
/// `T` = no terminal colour codes, `M` = metric, `n` = narrow output.
fn wttr_url(city: &str) -> String {
    let encoded = url_encode_path(city.trim());
    format!("https://wttr.in/{encoded}?0&T&M&lang=uk")
}

/// Minimal path-component encoder — wttr accepts spaces as `+` or
/// `%20`, we use `%20` so multi-word cities round-trip. Everything
/// outside alnum / - . _ / gets percent-encoded.
fn url_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '/') {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for byte in c.encode_utf8(&mut buf).as_bytes() {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

pub async fn fetch_weather(city: &str) -> Result<String, String> {
    if city.trim().is_empty() {
        return Err("місто не вказане".into());
    }
    let url = wttr_url(city);
    // reqwest is already a dep (downloader / whisper). 8 s covers wttr's
    // worst case without stranding the caller on a dead connection —
    // the assistant tool-loop has its own 5 s budget.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("curl/8 stash-cli")
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("wttr: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("wttr returned {}", status.as_u16()));
    }
    let body = resp.text().await.map_err(|e| format!("wttr body: {e}"))?;
    // wttr in text mode still includes an ANSI sequence or two — drop them.
    let cleaned = strip_ansi(&body);
    Ok(cleaned.trim().to_string())
}

fn strip_ansi(s: &str) -> String {
    // Single-pass removal of ESC [ ... letter sequences. Good enough
    // for wttr's output — it never emits nested CSI sequences.
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.next() != Some('[') {
                continue;
            }
            for inner in chars.by_ref() {
                if inner.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Extract a location from the memory facts list. Convention: any fact
/// starting with `location:` (case-insensitive) — trailing value is the
/// city/region name. The assistant learns to use this prefix via its
/// system prompt; the user can also write it themselves with
/// `/remember location: Київ`.
pub fn location_from_facts(facts: &[String]) -> Option<String> {
    facts
        .iter()
        .find_map(|f| {
            let lower = f.to_lowercase();
            let stripped = lower
                .strip_prefix("location:")
                .or_else(|| lower.strip_prefix("live in:"))
                .or_else(|| lower.strip_prefix("city:"))?;
            // Preserve original casing from the source fact by taking
            // the same suffix slice out of `f`, not the lowercased copy.
            let idx = f.len() - stripped.len();
            Some(f[idx..].trim().to_string())
        })
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encodes_unicode_city_names() {
        let url = wttr_url("Київ");
        assert!(url.starts_with("https://wttr.in/"));
        assert!(url.contains("%D0%9A")); // К
        assert!(url.contains("lang=uk"));
    }

    #[test]
    fn url_keeps_ascii_city_names_unchanged() {
        let url = wttr_url("Kyiv");
        assert!(url.contains("/Kyiv?"));
    }

    #[test]
    fn location_from_facts_picks_matching_prefix() {
        let facts = vec![
            "likes tea".into(),
            "location: Київ".into(),
            "has two cats".into(),
        ];
        assert_eq!(location_from_facts(&facts).as_deref(), Some("Київ"));
    }

    #[test]
    fn location_from_facts_accepts_alternative_prefixes() {
        assert_eq!(
            location_from_facts(&["live in: Lviv".into()]).as_deref(),
            Some("Lviv")
        );
        assert_eq!(
            location_from_facts(&["city: Warsaw".into()]).as_deref(),
            Some("Warsaw")
        );
    }

    #[test]
    fn location_from_facts_returns_none_when_nothing_matches() {
        let facts = vec!["likes tea".into(), "works remote".into()];
        assert!(location_from_facts(&facts).is_none());
    }

    #[test]
    fn strip_ansi_removes_colour_codes() {
        let s = "\x1b[31mred\x1b[0m plain";
        assert_eq!(strip_ansi(s), "red plain");
    }
}
