use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProgressUpdate {
    pub percent: f64,
    pub bytes_done: Option<u64>,
    pub bytes_total: Option<u64>,
    pub speed_bps: Option<u64>,
    pub eta_seconds: Option<u64>,
}

/// Parse one line of yt-dlp stdout. yt-dlp prints progress like:
/// `[download]   1.3% of   12.34MiB at  1.23MiB/s ETA 00:09`
/// Returns `None` if the line is not a progress line.
pub fn parse_line(line: &str) -> Option<ProgressUpdate> {
    let line = line.trim();
    if !line.starts_with("[download]") {
        return None;
    }
    let body = line.trim_start_matches("[download]").trim();
    if !body.contains('%') {
        return None;
    }
    let percent = first_number(body)?;
    let bytes_total = after_keyword(body, "of ").and_then(parse_size);
    let speed_bps = after_keyword(body, "at ").and_then(parse_speed);
    let eta_seconds = after_keyword(body, "ETA ").and_then(parse_eta);
    let bytes_done = match (bytes_total, percent) {
        (Some(total), p) if p > 0.0 => Some(((total as f64) * (p / 100.0)) as u64),
        _ => None,
    };
    Some(ProgressUpdate {
        percent,
        bytes_done,
        bytes_total,
        speed_bps,
        eta_seconds,
    })
}

fn first_number(s: &str) -> Option<f64> {
    let mut chars = s.chars().peekable();
    let mut buf = String::new();
    for c in chars.by_ref() {
        if c.is_ascii_digit() || c == '.' {
            buf.push(c);
        } else if !buf.is_empty() {
            break;
        }
    }
    buf.parse().ok()
}

fn after_keyword<'a>(s: &'a str, kw: &str) -> Option<&'a str> {
    s.find(kw).map(|i| &s[i + kw.len()..])
}

fn parse_size(s: &str) -> Option<u64> {
    let token = s.split_whitespace().next()?;
    let (num_str, unit) = split_suffix(token);
    let num: f64 = num_str.parse().ok()?;
    let mul: f64 = match unit.to_ascii_uppercase().as_str() {
        "B" | "" => 1.0,
        "KIB" | "KB" => 1024.0,
        "MIB" | "MB" => 1024.0 * 1024.0,
        "GIB" | "GB" => 1024.0 * 1024.0 * 1024.0,
        "TIB" | "TB" => 1024.0_f64.powi(4),
        _ => return None,
    };
    Some((num * mul) as u64)
}

fn parse_speed(s: &str) -> Option<u64> {
    // yt-dlp speed looks like "1.23MiB/s"
    let token = s.split_whitespace().next()?;
    let base = token.strip_suffix("/s").unwrap_or(token);
    parse_size(base)
}

fn parse_eta(s: &str) -> Option<u64> {
    // ETA comes as mm:ss or hh:mm:ss
    let token = s.split_whitespace().next()?;
    let parts: Vec<&str> = token.split(':').collect();
    let to_u64 = |x: &&str| x.parse::<u64>().ok();
    match parts.as_slice() {
        [mm, ss] => Some(to_u64(mm)? * 60 + to_u64(ss)?),
        [hh, mm, ss] => Some(to_u64(hh)? * 3600 + to_u64(mm)? * 60 + to_u64(ss)?),
        _ => None,
    }
}

fn split_suffix(token: &str) -> (&str, &str) {
    let pos = token.find(|c: char| !(c.is_ascii_digit() || c == '.'));
    match pos {
        Some(i) => (&token[..i], &token[i..]),
        None => (token, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_progress_line() {
        let line = "[download]   1.3% of   12.34MiB at  1.23MiB/s ETA 00:09";
        let u = parse_line(line).unwrap();
        assert!((u.percent - 1.3).abs() < 0.01);
        assert!(u.bytes_total.unwrap() > 12_000_000 && u.bytes_total.unwrap() < 13_500_000);
        assert!(u.speed_bps.unwrap() > 1_000_000 && u.speed_bps.unwrap() < 2_000_000);
        assert_eq!(u.eta_seconds, Some(9));
        assert!(u.bytes_done.is_some());
    }

    #[test]
    fn parses_100_percent_line_with_no_eta() {
        let line = "[download] 100% of 20.00MiB in 00:08";
        let u = parse_line(line).unwrap();
        assert!((u.percent - 100.0).abs() < 0.01);
    }

    #[test]
    fn returns_none_for_unrelated_lines() {
        assert!(parse_line("[youtube] extracting info").is_none());
        assert!(parse_line("[download] Destination: foo.mp4").is_none());
        assert!(parse_line("random text").is_none());
    }

    #[test]
    fn parses_hours_in_eta() {
        let u = parse_line("[download]   0.5% of   1.0GiB at  100KiB/s ETA 01:02:03").unwrap();
        assert_eq!(u.eta_seconds, Some(3600 + 120 + 3));
    }

    #[test]
    fn parses_gib_total_size() {
        let u = parse_line("[download]  50.0% of 2.0GiB at 5.0MiB/s ETA 00:10").unwrap();
        let total = u.bytes_total.unwrap();
        assert!(total > 2_000_000_000 && total < 2_200_000_000);
    }
}
