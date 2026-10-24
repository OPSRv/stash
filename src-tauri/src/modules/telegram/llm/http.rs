//! Shared HTTP plumbing for the REST adapters (OpenAI, Anthropic,
//! Gemini): one client builder with sane timeouts, one retry loop and
//! one status → `LlmError` mapping, so the providers only differ in
//! URL, auth headers and wire shape.

use std::time::Duration;

use serde_json::Value;

use super::{truncate_chars, LlmError};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(120);
/// Total attempts including the first one.
const MAX_ATTEMPTS: u32 = 3;
const BASE_BACKOFF: Duration = Duration::from_millis(500);
/// Longest `retry-after` we're willing to sleep through. Anything
/// longer surfaces immediately — the user is waiting on a chat reply.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(10);

/// HTTP client with a connect + total timeout. A bare
/// `reqwest::Client::new()` waits forever on a hung provider.
pub(crate) fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Turn a reqwest error into `LlmError::Network`, stripping the request
/// URL first — it can carry secrets (query-string API keys) and the
/// message is logged and relayed to Telegram.
pub(crate) fn network_error(e: reqwest::Error) -> LlmError {
    LlmError::Network(e.without_url().to_string())
}

fn is_retryable_status(status: u16) -> bool {
    status == 429 || (500..=599).contains(&status)
}

/// Delay before retry number `attempt` (0-based), or `None` when the
/// server asked us to wait longer than we're willing to. `retry_after`
/// is the raw header value; only the delta-seconds form is honoured
/// (HTTP-date is rare for LLM APIs and falls back to backoff).
fn retry_delay(attempt: u32, retry_after: Option<&str>) -> Option<Duration> {
    if let Some(secs) = retry_after.and_then(|v| v.trim().parse::<f64>().ok()) {
        if secs.is_finite() && secs >= 0.0 {
            let d = Duration::from_secs_f64(secs);
            return (d <= MAX_RETRY_AFTER).then_some(d);
        }
    }
    Some(BASE_BACKOFF * 2u32.pow(attempt))
}

/// POST the request produced by `build` (called once per attempt —
/// a `RequestBuilder` isn't reusable) and return the parsed JSON body
/// of a successful response.
///
/// Retries network errors (except timeouts — the 120s budget is already
/// spent), 429 and 5xx with exponential backoff, honouring
/// `retry-after`. `classify` gets the first look at a non-success
/// response so adapters can map provider quirks (e.g. Gemini's
/// `API_KEY_INVALID` 400) before the generic mapping.
pub(crate) async fn post_json_with_retry(
    build: impl Fn() -> reqwest::RequestBuilder,
    classify: impl Fn(u16, &str) -> Option<LlmError>,
) -> Result<Value, LlmError> {
    let mut attempt = 0u32;
    let response = loop {
        let last = attempt + 1 >= MAX_ATTEMPTS;
        match build().send().await {
            Ok(r) => {
                let status = r.status().as_u16();
                if !last && is_retryable_status(status) {
                    let retry_after = r
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok());
                    if let Some(delay) = retry_delay(attempt, retry_after) {
                        tracing::debug!(status, ?delay, attempt, "llm: retrying request");
                        tokio::time::sleep(delay).await;
                        attempt += 1;
                        continue;
                    }
                }
                break r;
            }
            Err(e) => {
                if !last && !e.is_timeout() {
                    if let Some(delay) = retry_delay(attempt, None) {
                        tracing::debug!(error = %e.without_url(), attempt, "llm: retrying after network error");
                        tokio::time::sleep(delay).await;
                        attempt += 1;
                        continue;
                    }
                }
                return Err(network_error(e));
            }
        }
    };

    let status = response.status().as_u16();
    // The repo's `reqwest` is compiled without the `json` feature;
    // parse as text + serde_json per existing convention.
    let text = response.text().await.map_err(network_error)?;
    if let Some(err) = classify(status, &text) {
        return Err(err);
    }
    map_response(status, &text)
}

/// Generic status → `LlmError` mapping + JSON parse.
fn map_response(status: u16, text: &str) -> Result<Value, LlmError> {
    match status {
        401 | 403 => return Err(LlmError::Auth),
        429 => return Err(LlmError::RateLimit),
        200..=299 => {}
        _ => {
            return Err(LlmError::BadResponse(format!(
                "status {status}: {}",
                truncate_chars(text, 200, "…")
            )))
        }
    }
    serde_json::from_str(text).map_err(|e| LlmError::BadResponse(format!("json parse: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_statuses() {
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(500));
        assert!(is_retryable_status(503));
        assert!(!is_retryable_status(400));
        assert!(!is_retryable_status(401));
        assert!(!is_retryable_status(200));
    }

    #[test]
    fn retry_delay_backs_off_exponentially() {
        assert_eq!(retry_delay(0, None), Some(Duration::from_millis(500)));
        assert_eq!(retry_delay(1, None), Some(Duration::from_millis(1000)));
        assert_eq!(retry_delay(2, None), Some(Duration::from_millis(2000)));
    }

    #[test]
    fn retry_delay_honours_retry_after() {
        assert_eq!(retry_delay(0, Some("3")), Some(Duration::from_secs(3)));
        assert_eq!(
            retry_delay(0, Some(" 0.5 ")),
            Some(Duration::from_millis(500))
        );
        // Too long to wait in a chat turn → give up.
        assert_eq!(retry_delay(0, Some("60")), None);
        // Unparseable (HTTP-date) → plain backoff.
        assert_eq!(
            retry_delay(1, Some("Wed, 21 Oct 2015 07:28:00 GMT")),
            Some(Duration::from_millis(1000))
        );
    }

    #[test]
    fn map_response_classifies_statuses() {
        assert_eq!(map_response(401, ""), Err(LlmError::Auth));
        assert_eq!(map_response(403, ""), Err(LlmError::Auth));
        assert_eq!(map_response(429, ""), Err(LlmError::RateLimit));
        match map_response(500, &"й".repeat(500)) {
            Err(LlmError::BadResponse(m)) => {
                assert!(m.starts_with("status 500: "));
                assert!(m.ends_with('…'));
            }
            other => panic!("expected BadResponse, got {other:?}"),
        }
        assert!(matches!(
            map_response(200, "not json"),
            Err(LlmError::BadResponse(_))
        ));
        assert_eq!(map_response(200, "{\"a\":1}").unwrap()["a"], 1);
    }
}
