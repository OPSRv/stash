use crate::modules::clipboard::commands::ClipboardState;
use crate::modules::downloader::runner::RunnerState;
use crate::modules::notes::commands::NotesState;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

/// A cross-module search hit. `kind` identifies which module it came from so
/// the UI can render an appropriate icon and route clicks.
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub kind: &'static str, // "clipboard" | "download" | "note"
    pub id: i64,
    pub title: String,
    pub snippet: String,
    pub ts: i64,
}

const PER_BUCKET: usize = 20;

/// Case-insensitive "contains" fallback that keeps the implementation simple
/// while still exercising each module's native search. If we later adopt an
/// FTS5 virtual table this function would switch to prepared MATCH queries.
#[tauri::command]
pub fn global_search(
    query: String,
    clipboard: State<'_, Arc<ClipboardState>>,
    downloader: State<'_, Arc<RunnerState>>,
    notes: State<'_, NotesState>,
) -> Result<Vec<SearchHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let mut hits: Vec<SearchHit> = Vec::new();

    // Clipboard — text items only; search() already filters.
    if let Ok(repo) = clipboard.repo.lock() {
        if let Ok(items) = repo.search(q, PER_BUCKET) {
            for it in items {
                hits.push(SearchHit {
                    kind: "clipboard",
                    id: it.id,
                    title: first_line(&it.content, 80),
                    snippet: truncate(&it.content, 160),
                    ts: it.created_at,
                });
            }
        }
    }

    // Downloads — LIKE over title/url against the existing in-memory list.
    if let Ok(jobs) = downloader.jobs.lock() {
        if let Ok(list) = jobs.list(500) {
            for j in list {
                let t = j.title.as_deref().unwrap_or("");
                let u = j.url.as_str();
                if contains_ci(t, q) || contains_ci(u, q) {
                    hits.push(SearchHit {
                        kind: "download",
                        id: j.id,
                        title: if !t.is_empty() { t.to_string() } else { u.to_string() },
                        snippet: format!(
                            "{} · {}",
                            j.status,
                            j.target_path.as_deref().unwrap_or(u)
                        ),
                        ts: j.completed_at.unwrap_or(j.created_at),
                    });
                    if hits.iter().filter(|h| h.kind == "download").count() >= PER_BUCKET {
                        break;
                    }
                }
            }
        }
    }

    // Notes — native LIKE search over title + body.
    if let Ok(repo) = notes.repo.lock() {
        if let Ok(list) = repo.search(q) {
            for n in list.into_iter().take(PER_BUCKET) {
                let title = if n.title.is_empty() {
                    first_line(&n.body, 60)
                } else {
                    n.title.clone()
                };
                hits.push(SearchHit {
                    kind: "note",
                    id: n.id,
                    title,
                    snippet: truncate(&n.body, 160),
                    ts: n.updated_at,
                });
            }
        }
    }

    // Sort newest first; UI is free to re-group by kind if it prefers.
    hits.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(hits)
}

fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

fn first_line(s: &str, max: usize) -> String {
    let first = s.split('\n').next().unwrap_or("").trim();
    truncate(first, max)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contains_ci_matches_mixed_case() {
        assert!(contains_ci("Hello World", "WORLD"));
        assert!(contains_ci("Stash Clipboard", "clip"));
        assert!(!contains_ci("Stash", "mvp"));
    }

    #[test]
    fn truncate_respects_char_count() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("abcdefghij", 5), "abcde…");
        // Multi-byte safety: ellipsis is added at char boundary, not byte.
        assert_eq!(truncate("абвгдежзик", 3), "абв…");
    }

    #[test]
    fn first_line_strips_trailing_content() {
        assert_eq!(first_line("hello\nworld", 20), "hello");
        assert_eq!(first_line("  spaced\nline", 20), "spaced");
    }
}
