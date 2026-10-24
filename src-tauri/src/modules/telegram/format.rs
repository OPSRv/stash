//! Outbound text formatting for Telegram: char-safe message splitting and a
//! small Markdown → Telegram-HTML converter for the Markdown LLMs (and our
//! own command replies) tend to produce.
//!
//! The converter is deliberately conservative: inline spans never cross a
//! line, unclosed markers stay literal, and `_`/`*` only open/close at word
//! boundaries so `snake_case_names` and `2*3*4` survive untouched. Anything
//! that isn't recognised markup is HTML-escaped, so the output is always
//! safe to send with `parse_mode=HTML`. If Telegram still rejects it, the
//! sender falls back to the raw text without a parse mode.

/// Telegram's hard cap for a single message text (after entity parsing).
pub const MESSAGE_LIMIT: usize = 4096;
/// Telegram's hard cap for a media caption (after entity parsing).
pub const CAPTION_LIMIT: usize = 1024;

/// Split `text` into chunks of at most `limit` chars, preferring paragraph
/// breaks, then line breaks, then whitespace, then a hard char cut. Never
/// splits inside a UTF-8 code point. Blank input yields no chunks.
pub fn split_message(text: &str, limit: usize) -> Vec<String> {
    let limit = limit.max(1);
    let mut out = Vec::new();
    let mut rest = text.trim_end();
    while !rest.trim().is_empty() {
        if rest.chars().count() <= limit {
            out.push(rest.to_string());
            break;
        }
        // Byte offset just past the `limit`-th char.
        let hard = rest
            .char_indices()
            .nth(limit)
            .map(|(i, _)| i)
            .unwrap_or(rest.len());
        let window = &rest[..hard];
        // Ignore break points in the first quarter of the window so a stray
        // early newline doesn't produce a tiny chunk.
        let min = window
            .char_indices()
            .nth(limit / 4)
            .map(|(i, _)| i)
            .unwrap_or(0);
        let cut = find_break(window, "\n\n", min)
            .or_else(|| find_break(window, "\n", min))
            .or_else(|| {
                window
                    .char_indices()
                    .rev()
                    .find(|(i, c)| *i > min && c.is_whitespace())
                    .map(|(i, c)| i + c.len_utf8())
            })
            .unwrap_or(hard);
        let chunk = rest[..cut].trim_end();
        if !chunk.is_empty() {
            out.push(chunk.to_string());
        }
        rest = rest[cut..].trim_start_matches(['\n', '\r']);
    }
    out
}

/// Byte offset just past the last `sep` in `window` that sits after `min`.
fn find_break(window: &str, sep: &str, min: usize) -> Option<usize> {
    window
        .rfind(sep)
        .filter(|i| *i > min)
        .map(|i| i + sep.len())
}

/// Keep ``` fences balanced across chunks: a chunk that ends inside a code
/// block gets a closing fence, and the next one reopens it, so each chunk
/// renders as code on its own.
pub fn balance_fences(chunks: Vec<String>) -> Vec<String> {
    let mut out = Vec::with_capacity(chunks.len());
    let mut open = false;
    for chunk in chunks {
        let mut c = if open { format!("```\n{chunk}") } else { chunk };
        let fences = c
            .lines()
            .filter(|l| l.trim_start().starts_with("```"))
            .count();
        open = fences % 2 == 1;
        if open {
            c.push_str("\n```");
        }
        out.push(c);
    }
    out
}

/// Escape the three characters Telegram's HTML parser cares about.
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        push_escaped(&mut out, c);
    }
    out
}

fn push_escaped(out: &mut String, c: char) {
    match c {
        '&' => out.push_str("&amp;"),
        '<' => out.push_str("&lt;"),
        '>' => out.push_str("&gt;"),
        '"' => out.push_str("&quot;"),
        _ => out.push(c),
    }
}

/// Convert common Markdown into the HTML subset Telegram accepts:
/// `**bold**`, `*italic*` / `_italic_`, `~~strike~~`, `` `code` ``,
/// fenced code blocks, `[text](url)` links and `#` headings (→ bold).
pub fn markdown_to_telegram_html(md: &str) -> String {
    let mut out = String::with_capacity(md.len() + 16);
    let mut in_code: Option<bool> = None; // Some(has_lang) while inside a fence
    let mut skip_nl = true; // no newline before the first line
    for line in md.split('\n') {
        if !std::mem::take(&mut skip_nl) {
            out.push('\n');
        }
        let trimmed = line.trim_start();
        if let Some(info) = trimmed.strip_prefix("```") {
            match in_code.take() {
                Some(has_lang) => {
                    // Drop the newline between the last code line and the fence.
                    if out.ends_with('\n') {
                        out.pop();
                    }
                    out.push_str(close_pre(has_lang));
                }
                None => {
                    let lang = info.trim();
                    let valid = !lang.is_empty()
                        && lang
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || "+-#_.".contains(c));
                    if valid {
                        out.push_str("<pre><code class=\"language-");
                        out.push_str(&escape_html(lang));
                        out.push_str("\">");
                    } else {
                        out.push_str("<pre>");
                    }
                    in_code = Some(valid);
                    // Code starts right after the tag, not on an empty line.
                    skip_nl = true;
                }
            }
            continue;
        }
        if in_code.is_some() {
            out.push_str(&escape_html(line));
            continue;
        }
        if let Some(heading) = heading_text(trimmed) {
            out.push_str("<b>");
            out.push_str(&inline(&heading.replace("**", "")));
            out.push_str("</b>");
            continue;
        }
        if let Some(item) = trimmed.strip_prefix("* ") {
            out.push_str(&line[..line.len() - trimmed.len()]);
            out.push_str("• ");
            out.push_str(&inline(item));
            continue;
        }
        out.push_str(&inline(line));
    }
    if let Some(has_lang) = in_code {
        out.push_str(close_pre(has_lang));
    }
    out
}

fn close_pre(has_lang: bool) -> &'static str {
    if has_lang {
        "</code></pre>"
    } else {
        "</pre>"
    }
}

/// `# Title` … `###### Title` → `Title`.
fn heading_text(line: &str) -> Option<&str> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.starts_with(' ') {
        return None;
    }
    let t = rest.trim().trim_end_matches('#').trim_end();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// Inline span conversion for a single line.
fn inline(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 8);
    inline_into(&chars, &mut out);
    out
}

fn inline_into(c: &[char], out: &mut String) {
    let mut i = 0;
    while i < c.len() {
        if let Some(next) = try_span(c, i, out) {
            i = next;
            continue;
        }
        push_escaped(out, c[i]);
        i += 1;
    }
}

/// Try to convert a span starting at `c[i]`. On success writes the HTML and
/// returns the index just past the span; otherwise leaves `out` untouched.
fn try_span(c: &[char], i: usize, out: &mut String) -> Option<usize> {
    let ch = c[i];
    match ch {
        // `code` — contents are literal.
        '`' => {
            let end = find_char(c, i + 1, '`')?;
            if end == i + 1 {
                return None;
            }
            out.push_str("<code>");
            for &x in &c[i + 1..end] {
                push_escaped(out, x);
            }
            out.push_str("</code>");
            Some(end + 1)
        }
        // **bold** / ~~strike~~
        '*' | '~' if c.get(i + 1) == Some(&ch) => {
            let end = find_double(c, i + 2, ch)?;
            if end == i + 2 || c[i + 2].is_whitespace() || c[end - 1].is_whitespace() {
                return None;
            }
            wrap(out, if ch == '*' { "b" } else { "s" }, &c[i + 2..end]);
            Some(end + 2)
        }
        // *italic* / _italic_ at word boundaries.
        '*' | '_' if opens_at(c, i) => {
            let end = find_italic_close(c, i + 1, ch)?;
            wrap(out, "i", &c[i + 1..end]);
            Some(end + 1)
        }
        // [text](url)
        '[' => {
            let (text_end, url_end) = find_link(c, i)?;
            let url: String = c[text_end + 2..url_end].iter().collect();
            if !is_safe_url(&url) {
                return None;
            }
            out.push_str("<a href=\"");
            out.push_str(&escape_html(&url));
            out.push_str("\">");
            inline_into(&c[i + 1..text_end], out);
            out.push_str("</a>");
            Some(url_end + 1)
        }
        _ => None,
    }
}

fn wrap(out: &mut String, tag: &str, inner: &[char]) {
    out.push('<');
    out.push_str(tag);
    out.push('>');
    inline_into(inner, out);
    out.push_str("</");
    out.push_str(tag);
    out.push('>');
}

fn find_char(c: &[char], from: usize, target: char) -> Option<usize> {
    (from..c.len()).find(|&j| c[j] == target)
}

fn find_double(c: &[char], from: usize, m: char) -> Option<usize> {
    (from..c.len().saturating_sub(1)).find(|&j| c[j] == m && c[j + 1] == m)
}

/// A single `*`/`_` opens italics when the next char is non-space and the
/// previous char isn't alphanumeric (so `snake_case` / `2*3` stay literal).
fn opens_at(c: &[char], i: usize) -> bool {
    let m = c[i];
    let next_ok = c
        .get(i + 1)
        .map(|n| !n.is_whitespace() && *n != m)
        .unwrap_or(false);
    let prev_ok = i == 0 || !(c[i - 1].is_alphanumeric() || c[i - 1] == m);
    next_ok && prev_ok
}

fn find_italic_close(c: &[char], from: usize, m: char) -> Option<usize> {
    (from..c.len()).find(|&j| {
        c[j] == m
            && j > from
            && !c[j - 1].is_whitespace()
            && c.get(j + 1)
                .map(|n| !n.is_alphanumeric() && *n != m)
                .unwrap_or(true)
    })
}

/// `[text](url)` starting at `i` → (index of `]`, index of `)`).
fn find_link(c: &[char], i: usize) -> Option<(usize, usize)> {
    let text_end = find_char(c, i + 1, ']')?;
    if text_end == i + 1 || c.get(text_end + 1) != Some(&'(') {
        return None;
    }
    let url_end = find_char(c, text_end + 2, ')')?;
    if url_end == text_end + 2 || c[text_end + 2..url_end].iter().any(|x| x.is_whitespace()) {
        return None;
    }
    Some((text_end, url_end))
}

fn is_safe_url(url: &str) -> bool {
    let l = url.to_ascii_lowercase();
    ["http://", "https://", "tg://", "mailto:"]
        .iter()
        .any(|p| l.starts_with(p))
}

/// Truncate to at most `max` chars (char-safe), appending `…` when cut.
pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn html(s: &str) -> String {
        markdown_to_telegram_html(s)
    }

    // ---- split_message ----

    #[test]
    fn split_short_text_is_single_chunk() {
        assert_eq!(split_message("привіт", 4096), vec!["привіт"]);
    }

    #[test]
    fn split_blank_yields_nothing() {
        assert!(split_message("", 10).is_empty());
        assert!(split_message("  \n\n ", 10).is_empty());
    }

    #[test]
    fn split_prefers_paragraph_boundary() {
        let text = format!("{}\n\n{}", "а".repeat(30), "б".repeat(30));
        let parts = split_message(&text, 40);
        assert_eq!(parts, vec!["а".repeat(30), "б".repeat(30)]);
    }

    #[test]
    fn split_falls_back_to_line_then_space() {
        let text = format!("{}\n{}", "x".repeat(30), "y".repeat(30));
        assert_eq!(split_message(&text, 40), vec!["x".repeat(30), "y".repeat(30)]);
        let words = "слово ".repeat(20);
        let parts = split_message(&words, 25);
        assert!(parts.iter().all(|p| p.chars().count() <= 25));
        assert!(parts.iter().all(|p| !p.starts_with(' ') && !p.ends_with(' ')));
        assert_eq!(parts.join(" "), words.trim_end());
    }

    #[test]
    fn split_hard_cuts_without_breaking_codepoints() {
        let text = "ї".repeat(25);
        let parts = split_message(&text, 10);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].chars().count(), 10);
        assert_eq!(parts[2].chars().count(), 5);
        assert_eq!(parts.concat(), text);
    }

    #[test]
    fn split_emoji_counts_as_chars() {
        let text = "🙂".repeat(9);
        let parts = split_message(&text, 4);
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|p| p.chars().count() <= 4));
    }

    #[test]
    fn split_respects_limit_on_large_input() {
        let para = format!("{}\n", "Рядок тексту з кирилицею. ".repeat(10));
        let text = para.repeat(50);
        let parts = split_message(&text, MESSAGE_LIMIT);
        assert!(parts.len() > 1);
        assert!(parts.iter().all(|p| p.chars().count() <= MESSAGE_LIMIT));
    }

    #[test]
    fn balance_fences_reopens_code_in_next_chunk() {
        let chunks = vec!["intro\n```rust\nlet a = 1;".to_string(), "let b = 2;\n```\nend".to_string()];
        let out = balance_fences(chunks);
        assert!(out[0].ends_with("\n```"));
        assert!(out[1].starts_with("```\nlet b"));
        assert_eq!(out[1].matches("```").count(), 2);
    }

    // ---- markdown_to_telegram_html ----

    #[test]
    fn escapes_html_specials() {
        assert_eq!(html("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d");
        assert_eq!(html("<script>"), "&lt;script&gt;");
    }

    #[test]
    fn bold_italic_code() {
        assert_eq!(html("**жирний** текст"), "<b>жирний</b> текст");
        assert_eq!(html("*курсив* і _теж_"), "<i>курсив</i> і <i>теж</i>");
        assert_eq!(html("run `a<b>` now"), "run <code>a&lt;b&gt;</code> now");
        assert_eq!(html("~~old~~ new"), "<s>old</s> new");
    }

    #[test]
    fn nested_spans() {
        assert_eq!(html("**bold _it_ end**"), "<b>bold <i>it</i> end</b>");
        assert_eq!(html("**`code` in bold**"), "<b><code>code</code> in bold</b>");
    }

    #[test]
    fn unclosed_markers_stay_literal() {
        assert_eq!(html("**not closed"), "**not closed");
        assert_eq!(html("*nope"), "*nope");
        assert_eq!(html("`tick"), "`tick");
        assert_eq!(html("[text](no close"), "[text](no close");
    }

    #[test]
    fn intraword_markers_are_not_formatting() {
        assert_eq!(html("snake_case_name"), "snake_case_name");
        assert_eq!(html("2*3*4 = 24"), "2*3*4 = 24");
        assert_eq!(html("file_2026_10.png"), "file_2026_10.png");
        assert_eq!(html("a * b * c"), "a * b * c");
    }

    #[test]
    fn links_with_safe_schemes_only() {
        assert_eq!(
            html("see [docs](https://x.dev/a?b=1&c=2)"),
            "see <a href=\"https://x.dev/a?b=1&amp;c=2\">docs</a>"
        );
        assert_eq!(html("[x](javascript:alert)"), "[x](javascript:alert)");
        assert_eq!(html("[**жирне** посилання](https://t.me)"), "<a href=\"https://t.me\"><b>жирне</b> посилання</a>");
    }

    #[test]
    fn headings_become_bold() {
        assert_eq!(html("# Заголовок"), "<b>Заголовок</b>");
        assert_eq!(html("### **Title** & more"), "<b>Title &amp; more</b>");
        assert_eq!(html("#hashtag"), "#hashtag");
    }

    #[test]
    fn bullets_render_as_dots() {
        assert_eq!(html("* one\n* two"), "• one\n• two");
        assert_eq!(html("- keep dash"), "- keep dash");
    }

    #[test]
    fn fenced_code_is_escaped_and_untouched() {
        let md = "До:\n```rust\nlet x = a < b && **c**;\n```\nПісля";
        assert_eq!(
            html(md),
            "До:\n<pre><code class=\"language-rust\">let x = a &lt; b &amp;&amp; **c**;</code></pre>\nПісля"
        );
    }

    #[test]
    fn fence_without_lang_and_unclosed_fence() {
        assert_eq!(html("```\ncode\n```"), "<pre>code</pre>");
        assert_eq!(html("```\nnever closed"), "<pre>never closed</pre>");
    }

    #[test]
    fn plain_cyrillic_passes_through() {
        let s = "Привіт! Як справи? Ціна — 5 грн.";
        assert_eq!(html(s), s);
    }

    #[test]
    fn truncate_is_char_safe() {
        assert_eq!(truncate_chars("привіт", 10), "привіт");
        assert_eq!(truncate_chars("привіт", 4), "при…");
    }
}
