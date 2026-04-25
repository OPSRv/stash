//! OCR / text-extraction pipeline. Apple Vision powers image OCR;
//! PDFKit handles the text layer first and falls back to per-page
//! Vision OCR for scanned documents. Used by the Telegram inbox so
//! photos / image documents / PDFs get a `transcript` row alongside
//! the original file — same UI as voice notes.

pub mod pdf;
pub mod vision;

use std::path::Path;

/// Decide whether a Telegram inbox row should run through OCR after
/// it lands on disk. Mirrors `is_transcribable` for the audio side.
///
/// `kind` is the inbox kind ("photo" / "document"). For documents the
/// caller passes the mime type Telegram reported so we can dispatch
/// images-as-files and PDFs without touching the bytes first.
pub fn is_ocr_able(kind: &str, mime: Option<&str>) -> bool {
    match kind {
        "photo" => true,
        "document" => match mime {
            Some(m) => {
                let m = m.to_ascii_lowercase();
                m.starts_with("image/") || m == "application/pdf"
            }
            None => false,
        },
        _ => false,
    }
}

/// Run the right extractor for `path` based on `mime` / extension.
/// Returns the extracted text (already trimmed). Empty string is a
/// valid result — the caller decides whether to record it.
pub fn extract_text(path: &Path, mime: Option<&str>) -> Result<String, String> {
    let is_pdf = mime
        .map(|m| m.eq_ignore_ascii_case("application/pdf"))
        .unwrap_or(false)
        || path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false);
    let raw = if is_pdf {
        pdf::extract_pdf_text(path)?
    } else {
        vision::recognize_text(path)?
    };
    Ok(raw.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_able_dispatches_on_kind_and_mime() {
        assert!(is_ocr_able("photo", None));
        assert!(is_ocr_able("photo", Some("image/jpeg")));
        assert!(is_ocr_able("document", Some("image/png")));
        assert!(is_ocr_able("document", Some("IMAGE/HEIC")));
        assert!(is_ocr_able("document", Some("application/pdf")));
        assert!(!is_ocr_able("document", Some("text/plain")));
        assert!(!is_ocr_able("document", None));
        assert!(!is_ocr_able("voice", None));
        assert!(!is_ocr_able("video", None));
    }
}
