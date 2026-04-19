//! Link preview fetcher — pulls og:image / og:title from an arbitrary URL.
//!
//! Uses the bundled `curl` (same pattern as `downloader::detector::fetch_oembed`)
//! to avoid pulling in a TLS crate. The HTML parser is regex-based and looks
//! at `<meta ...>` tags only — enough for the ~95% of pages that follow the
//! OpenGraph convention and much simpler than pulling in html5ever.

use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkPreview {
    pub url: String,
    pub image: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
}

impl LinkPreview {
    pub fn is_empty(&self) -> bool {
        self.image.is_none()
            && self.title.is_none()
            && self.description.is_none()
            && self.site_name.is_none()
    }
}

/// Fetch the URL with curl and extract a LinkPreview from the HTML head.
/// Returns None if the fetch fails or nothing useful is in the markup.
pub fn fetch_preview(url: &str) -> Option<LinkPreview> {
    // Limit body size — og meta lives in the first kilobytes of <head>, so 128 KB is plenty.
    let out = Command::new("curl")
        .args([
            "-sSL",
            "--max-time",
            "5",
            "--max-filesize",
            "262144",
            "-A",
            "Mozilla/5.0 (compatible; Stash/0.1; +https://github.com/OPSRv/stash)",
        ])
        .arg(url)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let body = String::from_utf8_lossy(&out.stdout);
    let preview = parse_link_preview(url, &body);
    if preview.is_empty() {
        None
    } else {
        Some(preview)
    }
}

/// Pure HTML → LinkPreview mapping. Extracted so tests don't touch the
/// network. Looks at `<head>` metadata in a case-insensitive, order-
/// independent way.
pub fn parse_link_preview(url: &str, html: &str) -> LinkPreview {
    let head = html
        .split_once("</head>")
        .map(|(h, _)| h)
        .unwrap_or(html);
    LinkPreview {
        url: url.to_string(),
        image: meta_content(head, &["og:image", "twitter:image", "twitter:image:src"]),
        title: meta_content(head, &["og:title", "twitter:title"])
            .or_else(|| extract_title_tag(head)),
        description: meta_content(head, &["og:description", "twitter:description", "description"]),
        site_name: meta_content(head, &["og:site_name", "application-name"]),
    }
}

fn meta_content(head: &str, keys: &[&str]) -> Option<String> {
    // Find each <meta ...> tag and check if it matches any of the keys.
    let lower = head.to_lowercase();
    let mut start = 0usize;
    while let Some(rel) = lower[start..].find("<meta") {
        let tag_start = start + rel;
        let tag_end = lower[tag_start..].find('>').map(|e| tag_start + e + 1)?;
        let tag = &head[tag_start..tag_end];
        if let Some((name, content)) = extract_meta_fields(tag) {
            if keys.iter().any(|k| k.eq_ignore_ascii_case(&name)) {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    return Some(html_unescape(trimmed));
                }
            }
        }
        start = tag_end;
    }
    None
}

/// Pull (name/property, content) out of a single `<meta ...>` tag. Returns
/// None if either attribute is missing.
fn extract_meta_fields(tag: &str) -> Option<(String, String)> {
    let name = attr_value(tag, "property").or_else(|| attr_value(tag, "name"))?;
    let content = attr_value(tag, "content")?;
    Some((name, content))
}

/// Case-insensitive attribute reader. Handles both double and single quotes.
fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let mut search_from = 0usize;
    while let Some(idx) = lower[search_from..].find(&attr.to_lowercase()) {
        let abs = search_from + idx;
        // Require a whitespace/< before the attribute name so `og:image`
        // doesn't match `twitter:image:src`.
        let before_ok = abs == 0
            || matches!(
                lower.as_bytes().get(abs - 1),
                Some(b' ' | b'\t' | b'\n' | b'\r' | b'<')
            );
        let after_idx = abs + attr.len();
        let after_ok = matches!(lower.as_bytes().get(after_idx), Some(b'=' | b' '));
        if before_ok && after_ok {
            // Skip to the '=' and then to the first quote.
            let rest = &tag[after_idx..];
            let eq = rest.find('=')?;
            let after_eq = &rest[eq + 1..];
            let trimmed = after_eq.trim_start();
            let (quote, payload_from) = match trimmed.chars().next()? {
                c @ ('"' | '\'') => (c, &trimmed[1..]),
                _ => return None,
            };
            let end = payload_from.find(quote)?;
            return Some(payload_from[..end].to_string());
        }
        search_from = abs + attr.len();
    }
    None
}

fn extract_title_tag(head: &str) -> Option<String> {
    let lower = head.to_lowercase();
    let open = lower.find("<title")?;
    let after_open = lower[open..].find('>')? + open + 1;
    let close_rel = lower[after_open..].find("</title>")?;
    let value = &head[after_open..after_open + close_rel];
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(html_unescape(trimmed))
    }
}

fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_og_image_and_title() {
        let html = r#"
            <html><head>
              <meta property="og:title" content="Hello">
              <meta property="og:image" content="https://cdn.example.com/og.png">
              <meta property="og:site_name" content="Example">
            </head><body></body></html>
        "#;
        let p = parse_link_preview("https://example.com/a", html);
        assert_eq!(p.title.as_deref(), Some("Hello"));
        assert_eq!(p.image.as_deref(), Some("https://cdn.example.com/og.png"));
        assert_eq!(p.site_name.as_deref(), Some("Example"));
    }

    #[test]
    fn falls_back_to_twitter_card_when_og_absent() {
        let html = r#"
            <head>
              <meta name="twitter:image" content="https://cdn.example.com/tw.png">
              <meta name="twitter:title" content="Tw Title">
            </head>
        "#;
        let p = parse_link_preview("https://x.com/a", html);
        assert_eq!(p.image.as_deref(), Some("https://cdn.example.com/tw.png"));
        assert_eq!(p.title.as_deref(), Some("Tw Title"));
    }

    #[test]
    fn handles_twitter_image_src_variant() {
        let html = r#"<head><meta name="twitter:image:src" content="https://cdn.example.com/v.png"></head>"#;
        let p = parse_link_preview("https://example.com", html);
        assert_eq!(p.image.as_deref(), Some("https://cdn.example.com/v.png"));
    }

    #[test]
    fn falls_back_to_title_tag_when_meta_title_missing() {
        let html = r#"<head><title>Just The Page</title></head>"#;
        let p = parse_link_preview("https://example.com", html);
        assert_eq!(p.title.as_deref(), Some("Just The Page"));
        assert!(p.image.is_none());
    }

    #[test]
    fn handles_single_quotes_and_mixed_case_attributes() {
        let html = r#"<head><META PROPERTY='og:image' CONTENT='https://x.com/a.png'></head>"#;
        let p = parse_link_preview("https://x.com", html);
        assert_eq!(p.image.as_deref(), Some("https://x.com/a.png"));
    }

    #[test]
    fn ignores_meta_tags_inside_body() {
        // Only <head> should be scanned: a fake og:image later in <body> must not win.
        let html = r#"
            <head><meta property="og:image" content="https://head.png"></head>
            <body><meta property="og:image" content="https://body.png"></body>
        "#;
        let p = parse_link_preview("https://example.com", html);
        assert_eq!(p.image.as_deref(), Some("https://head.png"));
    }

    #[test]
    fn unescapes_html_entities_in_values() {
        let html = r#"<head><meta property="og:title" content="Foo &amp; Bar"></head>"#;
        let p = parse_link_preview("https://example.com", html);
        assert_eq!(p.title.as_deref(), Some("Foo & Bar"));
    }

    #[test]
    fn returns_empty_when_no_metadata_present() {
        let html = "<html><head></head><body>hello</body></html>";
        let p = parse_link_preview("https://example.com", html);
        assert!(p.is_empty());
    }

    #[test]
    fn skips_meta_tags_missing_required_attributes() {
        let html = r#"<head><meta charset="utf-8"><meta property="og:image"></head>"#;
        let p = parse_link_preview("https://example.com", html);
        assert!(p.image.is_none());
    }

    #[test]
    fn prefers_og_image_over_twitter_when_both_present() {
        let html = r#"
            <head>
              <meta property="og:image" content="https://og.png">
              <meta name="twitter:image" content="https://tw.png">
            </head>
        "#;
        let p = parse_link_preview("https://example.com", html);
        assert_eq!(p.image.as_deref(), Some("https://og.png"));
    }
}
