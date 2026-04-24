use std::process::Command;

/// Translate `text` via Google's free `translate_a/single` endpoint. It does
/// not require an API key — the `gtx` client is used by the web widget and
/// tolerates modest rates. Production deployments should swap this for DeepL
/// or Apple Translation (see roadmap), but it is zero-config and keeps the
/// feature shippable today.
fn is_valid_lang(s: &str) -> bool {
    s == "auto"
        || (!s.is_empty()
            && s.len() <= 16
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

pub fn translate_via_google(text: &str, from: &str, to: &str) -> Result<String, String> {
    if text.is_empty() {
        return Ok(String::new());
    }
    let from = if from.is_empty() { "auto" } else { from };
    if !is_valid_lang(from) {
        return Err(format!("invalid source language code: {from:?}"));
    }
    if !is_valid_lang(to) {
        return Err(format!("invalid target language code: {to:?}"));
    }
    let url = format!(
        "https://translate.googleapis.com/translate_a/single\
         ?client=gtx&sl={from}&tl={to}&dt=t&q={}",
        url_encode(text)
    );
    let out = Command::new("curl")
        .args(["-sSL", "--max-time", "6", "-A", "Mozilla/5.0"])
        .arg(&url)
        .output()
        .map_err(|e| format!("spawn curl: {e}"))?;
    if !out.status.success() {
        return Err(format!("curl exited with {}", out.status));
    }
    let body = String::from_utf8_lossy(&out.stdout);
    parse_google_response(&body)
}

/// Parse `[[["<translated>","<original>",null,null,10], ...], ...]`.
/// Concatenates all sentence-level translation chunks so multi-paragraph
/// input survives intact.
pub fn parse_google_response(body: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("parse json: {e}"))?;
    let chunks = v
        .get(0)
        .and_then(|x| x.as_array())
        .ok_or_else(|| "unexpected response shape".to_string())?;
    let mut out = String::new();
    for chunk in chunks {
        if let Some(s) = chunk.get(0).and_then(|s| s.as_str()) {
            out.push_str(s);
        }
    }
    if out.is_empty() {
        return Err("empty translation".into());
    }
    Ok(out)
}

/// Cheap language-detection heuristic used to decide whether to auto-translate:
/// returns true when at least 85% of the input's letters are ASCII. Good
/// enough to catch plain English (and other Latin-script text) while skipping
/// already-translated Cyrillic/CJK content.
pub fn is_mostly_ascii_letters(text: &str) -> bool {
    let letters: Vec<char> = text.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.is_empty() {
        return false;
    }
    let ascii = letters.iter().filter(|c| c.is_ascii()).count();
    (ascii as f64 / letters.len() as f64) >= 0.85
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_google_response_concatenates_sentence_chunks() {
        let body = r#"[[["Привіт світ","Hello world",null,null,10],
                        [". Як справи?"," How are you?",null,null,10]],
                        null,"en"]"#;
        let translated = parse_google_response(body).unwrap();
        assert_eq!(translated, "Привіт світ. Як справи?");
    }

    #[test]
    fn parse_google_response_rejects_empty_payload() {
        assert!(parse_google_response("[[]]").is_err());
    }

    #[test]
    fn is_mostly_ascii_letters_detects_english_vs_cyrillic() {
        assert!(is_mostly_ascii_letters(
            "Hello there, how are you doing today?"
        ));
        assert!(!is_mostly_ascii_letters("Привіт, як справи?"));
        // Mixed but overwhelmingly cyrillic — should not be treated as english.
        assert!(!is_mostly_ascii_letters("Це test перевірка"));
    }

    #[test]
    fn is_mostly_ascii_letters_ignores_digits_and_punctuation() {
        assert!(is_mostly_ascii_letters("abc 123 !@#"));
    }

    #[test]
    fn is_mostly_ascii_letters_returns_false_for_no_letters() {
        assert!(!is_mostly_ascii_letters("12345 !!! 2026-04-19"));
    }

    #[test]
    fn url_encode_percent_escapes_non_unreserved() {
        assert_eq!(url_encode("Hello world"), "Hello%20world");
        assert_eq!(url_encode("a&b=c"), "a%26b%3Dc");
    }
}
