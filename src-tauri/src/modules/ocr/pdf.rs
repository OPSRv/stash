//! PDF text extraction. Tries the embedded text layer first via
//! `PDFDocument.string` — fast, accurate, and the format the document
//! was authored in. When that comes back empty (typical for scanned
//! PDFs) every page is rendered to a TIFF bitmap and run through
//! Apple Vision OCR.
//!
//! The render → OCR fallback writes pages to short-lived temp files;
//! they're removed after each page so a 50-page scan never holds more
//! than one bitmap on disk at a time.

#[cfg(target_os = "macos")]
use std::path::Path;

#[cfg(target_os = "macos")]
pub fn extract_pdf_text(path: &Path) -> Result<String, String> {
    use objc2::AnyThread;
    use objc2_foundation::NSURL;
    use objc2_pdf_kit::{PDFDisplayBox, PDFDocument};

    if !path.is_file() {
        return Err(format!("file not found: {}", path.display()));
    }
    let url = NSURL::from_file_path(path).ok_or_else(|| "invalid pdf path".to_string())?;
    // SAFETY: URL is a valid file URL; PDFKit reads it eagerly.
    let document = unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) }
        .ok_or_else(|| "could not open pdf".to_string())?;

    // 1. Native text layer. Most PDFs have one.
    if let Some(s) = unsafe { document.string() } {
        let text = s.to_string();
        if !text.trim().is_empty() {
            return Ok(text);
        }
    }

    // 2. Scanned PDF fallback — render each page → OCR.
    let page_count = unsafe { document.pageCount() };
    if page_count == 0 {
        return Ok(String::new());
    }
    let mut out = String::new();
    for i in 0..page_count {
        let Some(page) = (unsafe { document.pageAtIndex(i) }) else {
            continue;
        };
        let bounds = unsafe { page.boundsForBox(PDFDisplayBox::MediaBox) };
        // 2× scale → ~144 DPI. Higher hurts performance on large docs
        // without much accuracy upside; lower starts to lose small print.
        let scale: f64 = 2.0;
        let target = objc2_foundation::NSSize {
            width: bounds.size.width * scale,
            height: bounds.size.height * scale,
        };
        let nsimage =
            unsafe { page.thumbnailOfSize_forBox(target, PDFDisplayBox::MediaBox) };
        let Some(tiff) = nsimage.TIFFRepresentation() else {
            continue;
        };

        // Stage the TIFF on disk so we can hand Vision a URL — the
        // simplest path that doesn't require reaching into Core
        // Graphics for a CGImage.
        let tmp = std::env::temp_dir().join(format!(
            "stash-pdfocr-{}-{}.tiff",
            std::process::id(),
            i
        ));
        let bytes = unsafe { tiff.as_bytes_unchecked() };
        if let Err(e) = std::fs::write(&tmp, bytes) {
            tracing::warn!(error = %e, "pdf-ocr: write tmp tiff failed");
            continue;
        }

        match super::vision::recognize_text(&tmp) {
            Ok(text) => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    if !out.is_empty() {
                        out.push_str("\n\n");
                    }
                    out.push_str(trimmed);
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, page = i, "pdf-ocr: page recognize failed");
            }
        }
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(out)
}

#[cfg(not(target_os = "macos"))]
pub fn extract_pdf_text(_path: &std::path::Path) -> Result<String, String> {
    Err("pdf extraction is macOS-only".into())
}
