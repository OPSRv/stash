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
        // Bare URLs are literal: `_` / `*` inside them must not open
        // italics (`https://x.com/_foo_/bar`).
        if let Some(end) = bare_url_end(c, i) {
            for &x in &c[i..end] {
                push_escaped(out, x);
            }
            i = end;
            continue;
        }
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

/// If a bare `http://` / `https://` token starts at `i` (at a token
/// boundary), the index just past it (first whitespace or end).
fn bare_url_end(c: &[char], i: usize) -> Option<usize> {
    if i > 0 && (c[i - 1].is_alphanumeric() || c[i - 1] == '_') {
        return None;
    }
    let starts = |p: &str| {
        let n = p.chars().count();
        c.len() >= i + n
            && c[i..i + n]
                .iter()
                .zip(p.chars())
                .all(|(a, b)| a.to_ascii_lowercase() == b)
    };
    if !(starts("https://") || starts("http://")) {
        return None;
    }
    Some(
        (i..c.len())
            .find(|&j| c[j].is_whitespace())
            .unwrap_or(c.len()),
    )
}

/// `[text](url)` starting at `i` → (index of `]`, index of `)`). Parens
/// inside the URL must balance (`https://en.wikipedia.org/wiki/Rust_(lang)`).
fn find_link(c: &[char], i: usize) -> Option<(usize, usize)> {
    let text_end = find_char(c, i + 1, ']')?;
    if text_end == i + 1 || c.get(text_end + 1) != Some(&'(') {
        return None;
    }
    let mut depth = 0usize;
    let mut url_end = None;
    for (j, &x) in c.iter().enumerate().skip(text_end + 2) {
        match x {
            _ if x.is_whitespace() => return None,
            '(' => depth += 1,
            ')' if depth == 0 => {
                url_end = Some(j);
                break;
            }
            ')' => depth -= 1,
            _ => {}
        }
    }
    let url_end = url_end?;
    if url_end == text_end + 2 {
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

// -------------------- Live progress for AI turns --------------------

/// Header of the progress placeholder before any tool has run.
pub const PROGRESS_THINKING: &str = "⏳ Думаю…";
/// Max step lines rendered; older ones collapse into a counter.
const PROGRESS_MAX_STEPS: usize = 8;
/// Max chars of an argument detail shown next to a tool label.
const PROGRESS_DETAIL_CHARS: usize = 40;

/// Tool name → (emoji, Ukrainian label, optional arg key whose value is
/// appended as a short detail).
const TOOL_LABELS: &[(&str, &str, &str, Option<&str>)] = &[
    ("search_notes", "🔎", "шукаю нотатки", Some("query")),
    ("list_notes", "📒", "переглядаю нотатки", None),
    ("get_note", "📄", "відкриваю нотатку", None),
    ("save_note", "📝", "зберігаю нотатку", None),
    ("append_to_note", "📝", "доповнюю нотатку", None),
    ("update_note", "✏️", "редагую нотатку", None),
    ("delete_note", "🗑", "видаляю нотатку", None),
    ("metronome_control", "🥁", "метроном", None),
    ("drums_control", "🥁", "драм-машина", None),
    ("tuner_control", "🎸", "тюнер", None),
    ("circle_progression", "🎼", "коло квінт", None),
    ("valeton_set_tone", "🎛", "налаштовую тон Valeton", None),
    ("valeton_control", "🎛", "Valeton", None),
    ("record_control", "🎙", "запис", None),
    ("music_control", "🎵", "музика", None),
    ("volume_control", "🔊", "гучність", None),
    ("get_battery", "🔋", "дивлюсь батарею", None),
    ("canvas_ocr_image", "🔍", "розпізнаю текст", None),
    ("remember_fact", "🧠", "запамʼятовую", None),
    ("list_facts", "🧠", "згадую факти", None),
    ("forget_fact", "🧠", "забуваю факт", None),
    ("create_reminder", "⏰", "ставлю нагадування", Some("when")),
    ("list_reminders", "⏰", "переглядаю нагадування", None),
    ("cancel_reminder", "⏰", "скасовую нагадування", None),
    ("send_telegram", "📨", "надсилаю повідомлення", None),
    ("navigate_tab", "🧭", "відкриваю вкладку", Some("tab")),
    ("npm_list_scripts", "📦", "дивлюсь npm-скрипти", None),
    ("npm_run_script", "▶️", "запускаю npm-скрипт", None),
    ("npm_stop_script", "⏹", "зупиняю npm-скрипт", None),
    ("invoke_command", "⚙️", "команда", Some("name")),
    ("separate_stems", "🎚", "розділяю на стеми", None),
    ("detect_bpm", "🥁", "визначаю BPM", None),
    ("get_separator_job", "🎚", "перевіряю розділення", None),
    ("convert_media", "🔄", "конвертую медіа", None),
    ("transcribe_to_file", "📝", "розшифровую аудіо", None),
    ("get_converter_job", "🔄", "перевіряю конвертацію", None),
    ("get_last_clip", "📋", "беру останній кліп", None),
    ("clipboard_search", "📋", "шукаю в буфері", Some("query")),
    ("clipboard_pin", "📌", "закріплюю кліп", None),
    ("clipboard_clear", "🧹", "очищаю буфер", None),
    ("clipboard_delete", "🗑", "видаляю кліп", None),
    ("clipboard_copy_to_mac", "📋", "копіюю на Mac", None),
    ("pomodoro_status", "🍅", "статус помодоро", None),
    ("pomodoro_start", "🍅", "запускаю помодоро", None),
    ("pomodoro_stop", "🍅", "зупиняю помодоро", None),
    ("pomodoro_save_preset", "🍅", "зберігаю пресет", None),
    ("pomodoro_control", "🍅", "помодоро", None),
    ("pomodoro_edit_blocks", "🍅", "редагую блоки", None),
    ("pomodoro_presets", "🍅", "пресети помодоро", None),
    ("pomodoro_history", "🍅", "історія помодоро", None),
    ("download_media", "⬇️", "завантажую", None),
    ("list_downloads", "⬇️", "список завантажень", None),
    ("get_download", "⬇️", "статус завантаження", None),
    ("cancel_download", "⬇️", "скасовую завантаження", None),
    ("control_download", "⬇️", "керую завантаженням", None),
    ("translate_text", "🌐", "перекладаю", None),
];

/// Human label for a tool step, e.g. `🥁 метроном 120 BPM` or
/// `🔎 шукаю нотатки «ідеї»`. Unknown tools fall back to `⚙️ <name>`.
pub fn tool_label(name: &str, args_json: &str) -> String {
    let Some(&(_, emoji, label, detail_key)) = TOOL_LABELS.iter().find(|(n, ..)| *n == name)
    else {
        return format!("⚙️ {name}");
    };
    let args: serde_json::Value = serde_json::from_str(args_json).unwrap_or_default();
    let mut out = format!("{emoji} {label}");
    if name == "metronome_control" {
        if let Some(bpm) = args.get("bpm").and_then(|v| v.as_f64()) {
            out.push_str(&format!(" {} BPM", bpm.round() as i64));
        }
    } else if let Some(v) = detail_key
        .and_then(|k| args.get(k))
        .and_then(|v| v.as_str())
        .map(sanitize_detail)
        .filter(|v| !v.is_empty())
    {
        if name == "invoke_command" {
            out.push_str(&format!(" /{v}"));
        } else {
            out.push_str(&format!(" «{v}»"));
        }
    }
    out
}

/// One-line, markup-free, length-capped argument detail.
fn sanitize_detail(s: &str) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !matches!(c, '*' | '_' | '`' | '[' | ']' | '~' | '|' | '<' | '>'))
        .collect();
    truncate_chars(flat.trim(), PROGRESS_DETAIL_CHARS)
}

/// State of one tool step in the progress message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    Running,
    Ok,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressStep {
    pub label: String,
    pub status: StepStatus,
}

/// Render the progress placeholder: one line per step (newest last),
/// with a trailing "thinking" line while no step is running.
pub fn render_progress(steps: &[ProgressStep]) -> String {
    if steps.is_empty() {
        return PROGRESS_THINKING.to_string();
    }
    let hidden = steps.len().saturating_sub(PROGRESS_MAX_STEPS);
    let mut lines: Vec<String> = Vec::with_capacity(PROGRESS_MAX_STEPS + 2);
    if hidden > 0 {
        lines.push(format!("… ще кроків: {hidden}"));
    }
    for s in &steps[hidden..] {
        lines.push(match s.status {
            StepStatus::Running => format!("⏳ {}…", s.label),
            StepStatus::Ok => format!("✅ {}", s.label),
            StepStatus::Failed => format!("⚠️ {}", s.label),
        });
    }
    if steps.iter().all(|s| s.status != StepStatus::Running) {
        lines.push(PROGRESS_THINKING.to_string());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_urls_are_not_italicised() {
        let h = markdown_to_telegram_html("see https://x.com/_foo_/bar ok");
        assert!(!h.contains("<i>"), "{h}");
        assert!(h.contains("https://x.com/_foo_/bar"), "{h}");
        let h = markdown_to_telegram_html("http://a.b/*x* and _real_");
        assert!(h.contains("http://a.b/*x*"), "{h}");
        assert!(h.contains("<i>real</i>"), "{h}");
    }

    #[test]
    fn link_urls_keep_balanced_parens() {
        let h = markdown_to_telegram_html("[Rust](https://en.wikipedia.org/wiki/Rust_(lang)) tail");
        assert!(
            h.contains("<a href=\"https://en.wikipedia.org/wiki/Rust_(lang)\">Rust</a> tail"),
            "{h}"
        );
        let h = markdown_to_telegram_html("[a](https://x.com/b)");
        assert!(h.contains("<a href=\"https://x.com/b\">a</a>"), "{h}");
    }

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

    #[test]
    fn tool_labels_map_known_tools_and_fall_back() {
        assert_eq!(
            tool_label("metronome_control", r#"{"action":"start","bpm":120}"#),
            "🥁 метроном 120 BPM"
        );
        assert_eq!(tool_label("metronome_control", "{}"), "🥁 метроном");
        assert_eq!(
            tool_label("search_notes", r#"{"query":"ідеї"}"#),
            "🔎 шукаю нотатки «ідеї»"
        );
        assert_eq!(
            tool_label("invoke_command", r#"{"name":"volume","args":"50"}"#),
            "⚙️ команда /volume"
        );
        assert_eq!(tool_label("mystery_tool", "{}"), "⚙️ mystery_tool");
        // Bad JSON never breaks the label.
        assert_eq!(tool_label("list_notes", "not json"), "📒 переглядаю нотатки");
    }

    #[test]
    fn tool_label_detail_is_flat_short_and_markup_free() {
        let long = format!(r#"{{"query":"a_b *c*\n{}"}}"#, "x".repeat(100));
        let l = tool_label("search_notes", &long);
        assert!(!l.contains('\n') && !l.contains('*') && !l.contains('_'), "{l}");
        assert!(l.chars().count() < 70, "{l}");
        assert!(l.ends_with("…»"), "{l}");
        // Blank detail is omitted entirely.
        assert_eq!(tool_label("search_notes", r#"{"query":"  "}"#), "🔎 шукаю нотатки");
    }

    fn step(label: &str, status: StepStatus) -> ProgressStep {
        ProgressStep {
            label: label.into(),
            status,
        }
    }

    #[test]
    fn progress_renders_steps_and_thinking_tail() {
        assert_eq!(render_progress(&[]), PROGRESS_THINKING);
        let running = [
            step("🥁 метроном", StepStatus::Ok),
            step("🔎 шукаю нотатки", StepStatus::Running),
        ];
        assert_eq!(
            render_progress(&running),
            "✅ 🥁 метроном\n⏳ 🔎 шукаю нотатки…"
        );
        let idle = [
            step("🥁 метроном", StepStatus::Ok),
            step("⚙️ x", StepStatus::Failed),
        ];
        assert_eq!(
            render_progress(&idle),
            format!("✅ 🥁 метроном\n⚠️ ⚙️ x\n{PROGRESS_THINKING}")
        );
    }

    #[test]
    fn progress_collapses_old_steps() {
        let steps: Vec<_> = (0..11)
            .map(|i| step(&format!("s{i}"), StepStatus::Ok))
            .collect();
        let out = render_progress(&steps);
        assert!(out.starts_with("… ще кроків: 3\n✅ s3\n"), "{out}");
        assert!(!out.contains("✅ s2\n"));
        assert_eq!(out.lines().count(), 1 + PROGRESS_MAX_STEPS + 1);
    }
}
