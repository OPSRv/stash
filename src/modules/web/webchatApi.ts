import { invoke } from '@tauri-apps/api/core';

export const webchatEmbed = (args: {
  service: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  userAgent?: string | null;
  initialZoom?: number | null;
}): Promise<void> =>
  invoke('webchat_embed', {
    service: args.service,
    url: args.url,
    x: args.x,
    y: args.y,
    width: args.width,
    height: args.height,
    userAgent: args.userAgent ?? null,
    initialZoom: args.initialZoom ?? null,
  });

/// Update the zoom level of an already-embedded service. Silent no-op when
/// the webview hasn't been attached yet — the next `webchatEmbed` picks the
/// persisted value up from settings.
export const webchatSetZoom = (service: string, zoom: number): Promise<void> =>
  invoke('webchat_set_zoom', { service, zoom });

export const webchatHide = (service: string): Promise<void> =>
  invoke('webchat_hide', { service });

export const webchatHideAll = (): Promise<void> => invoke('webchat_hide_all');

export const webchatReload = (service: string, url: string): Promise<void> =>
  invoke('webchat_reload', { service, url });

/// Current URL of the embedded webview — where the user actually navigated,
/// not the `url` passed to `webchat_embed`. Rejects if the webview is not
/// currently attached.
export const webchatCurrentUrl = (service: string): Promise<string> =>
  invoke('webchat_current_url', { service });

export const webchatBack = (service: string): Promise<void> =>
  invoke('webchat_back', { service });

export const webchatForward = (service: string): Promise<void> =>
  invoke('webchat_forward', { service });

export const webchatClose = (service: string): Promise<void> =>
  invoke('webchat_close', { service });

/// Destroy every attached webchat webview (reclaims the web process memory).
/// Pass `keep` to preserve a single service — useful when the AI tab is
/// active and the user is mid-session with one specific chat.
export const webchatCloseAll = (keep?: string | null): Promise<void> =>
  invoke('webchat_close_all', { keep: keep ?? null });

export const webchatTogglePlay = (service: string): Promise<void> =>
  invoke('webchat_toggle_play', { service });

/// Payload of the `webchat:nav` Tauri event. Emitted by the injected
/// script whenever the embedded webview's URL or document title changes
/// (load, pushState/replaceState, hashchange, popstate, title mutation).
export type WebchatNav = {
  service: string;
  url: string;
  title: string;
};

export type WebchatNowPlaying = {
  service: string;
  playing: boolean;
  title: string;
  artist: string;
  artwork: string;
};

/// Google's s2 favicon service — returns a 32×32 icon for any public domain,
/// no API key, CORS-friendly for <img> tags. Accepts a full URL and extracts
/// the hostname.
export const faviconUrlFor = (serviceUrl: string, size = 32): string | null => {
  try {
    const { hostname } = new URL(serviceUrl);
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=${size}`;
  } catch {
    return null;
  }
};
