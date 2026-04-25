//! Apple Vision OCR — `VNRecognizeTextRequest` over a file URL.
//!
//! Returns the joined text from every observation, in detection order.
//! Languages: Ukrainian + English (the Stash default surface). Russian
//! is intentionally excluded — see project rule «no Russian language
//! support».
//!
//! Runs synchronously: `performRequests:error:` blocks until Vision is
//! done, which is the natural shape for our "spawn one task per file"
//! caller. Average runtime is sub-second on Apple Silicon.

#[cfg(target_os = "macos")]
use std::path::Path;

#[cfg(target_os = "macos")]
pub fn recognize_text(path: &Path) -> Result<String, String> {
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    if !path.is_file() {
        return Err(format!("file not found: {}", path.display()));
    }

    let url = NSURL::from_file_path(path).ok_or_else(|| "invalid file path".to_string())?;
    let empty_options: Retained<NSDictionary<NSString, objc2::runtime::AnyObject>> =
        NSDictionary::new();

    // SAFETY: well-formed URL + empty options dict. Vision keeps no
    // reference to either past performRequests.
    let handler = unsafe {
        VNImageRequestHandler::initWithURL_options(
            VNImageRequestHandler::alloc(),
            &url,
            &empty_options,
        )
    };

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);
    let langs =
        NSArray::from_retained_slice(&[NSString::from_str("uk-UA"), NSString::from_str("en-US")]);
    request.setRecognitionLanguages(&langs);

    // performRequests wants NSArray<VNRequest>. The recognize-text
    // request is a subclass of VNRequest, so we coerce through the
    // Deref chain set up by `extern_class!(super(...))`.
    let req_as_base: &VNRequest = &request;
    let requests = NSArray::from_slice(&[req_as_base]);
    handler
        .performRequests_error(&requests)
        .map_err(|e| format!("vision performRequests failed: {e:?}"))?;

    let Some(observations) = request.results() else {
        return Ok(String::new());
    };

    let mut out = String::new();
    for obs in observations.iter() {
        let candidates = obs.topCandidates(1);
        if let Some(top) = candidates.iter().next() {
            let line = top.string().to_string();
            if !line.is_empty() {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&line);
            }
        }
    }
    Ok(out)
}

/// Stub for non-mac builds so the rest of the crate compiles. Stash
/// is macOS-only, but `cargo check --target ...` on CI without the
/// guard would break.
#[cfg(not(target_os = "macos"))]
pub fn recognize_text(_path: &std::path::Path) -> Result<String, String> {
    Err("vision OCR is macOS-only".into())
}
