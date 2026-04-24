use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    YouTube,
    Instagram,
    TikTok,
    Twitter,
    Reddit,
    Vimeo,
    Twitch,
    Facebook,
    Generic,
}

impl Platform {
    pub fn from_url(url: &str) -> Platform {
        let host = extract_host(url).unwrap_or_default().to_lowercase();
        let host = host.trim_start_matches("www.");
        match host {
            h if h.ends_with("youtube.com") || h.ends_with("youtu.be") => Platform::YouTube,
            h if h.ends_with("instagram.com") => Platform::Instagram,
            h if h.ends_with("tiktok.com") => Platform::TikTok,
            h if h.ends_with("twitter.com") || h.ends_with("x.com") => Platform::Twitter,
            h if h.ends_with("reddit.com") => Platform::Reddit,
            h if h.ends_with("vimeo.com") => Platform::Vimeo,
            h if h.ends_with("twitch.tv") => Platform::Twitch,
            h if h.ends_with("facebook.com") || h.ends_with("fb.watch") => Platform::Facebook,
            _ => Platform::Generic,
        }
    }

    #[allow(dead_code)]
    pub fn as_badge(&self) -> &'static str {
        match self {
            Platform::YouTube => "YOUTUBE",
            Platform::Instagram => "INSTAGRAM",
            Platform::TikTok => "TIKTOK",
            Platform::Twitter => "X",
            Platform::Reddit => "REDDIT",
            Platform::Vimeo => "VIMEO",
            Platform::Twitch => "TWITCH",
            Platform::Facebook => "FACEBOOK",
            Platform::Generic => "LINK",
        }
    }
}

fn extract_host(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let end = rest.find('/').unwrap_or(rest.len());
    let hostport = &rest[..end];
    // strip :port
    Some(hostport.split(':').next().unwrap_or(hostport))
}

#[allow(dead_code)]
pub fn is_supported_video_url(url: &str) -> bool {
    Platform::from_url(url) != Platform::Generic
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_youtube() {
        assert_eq!(
            Platform::from_url("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
            Platform::YouTube
        );
        assert_eq!(
            Platform::from_url("https://youtu.be/jNQXAC9IVRw"),
            Platform::YouTube
        );
    }

    #[test]
    fn detects_tiktok() {
        assert_eq!(
            Platform::from_url("https://www.tiktok.com/@user/video/12345"),
            Platform::TikTok
        );
    }

    #[test]
    fn detects_instagram() {
        assert_eq!(
            Platform::from_url("https://www.instagram.com/reel/abc/"),
            Platform::Instagram
        );
    }

    #[test]
    fn detects_twitter_and_x() {
        assert_eq!(
            Platform::from_url("https://twitter.com/user/status/123"),
            Platform::Twitter
        );
        assert_eq!(
            Platform::from_url("https://x.com/user/status/123"),
            Platform::Twitter
        );
    }

    #[test]
    fn detects_reddit() {
        assert_eq!(
            Platform::from_url("https://www.reddit.com/r/foo/comments/bar"),
            Platform::Reddit
        );
    }

    #[test]
    fn detects_vimeo_twitch_facebook() {
        assert_eq!(
            Platform::from_url("https://vimeo.com/12345"),
            Platform::Vimeo
        );
        assert_eq!(
            Platform::from_url("https://www.twitch.tv/clip/x"),
            Platform::Twitch
        );
        assert_eq!(
            Platform::from_url("https://fb.watch/abc"),
            Platform::Facebook
        );
    }

    #[test]
    fn falls_back_to_generic() {
        assert_eq!(
            Platform::from_url("https://example.com/video.mp4"),
            Platform::Generic
        );
    }

    #[test]
    fn handles_http_and_https() {
        assert_eq!(
            Platform::from_url("http://youtube.com/watch"),
            Platform::YouTube
        );
    }

    #[test]
    fn strips_www_prefix() {
        assert_eq!(
            Platform::from_url("https://www.tiktok.com/foo"),
            Platform::TikTok
        );
    }

    #[test]
    fn is_supported_is_true_for_known_hosts() {
        assert!(is_supported_video_url("https://youtu.be/abc"));
        assert!(!is_supported_video_url("https://example.com/"));
        assert!(!is_supported_video_url("not a url"));
    }
}
