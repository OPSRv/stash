import { invoke } from '@tauri-apps/api/core';

export const webchatEmbed = (args: {
  service: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  userAgent?: string | null;
}): Promise<void> =>
  invoke('webchat_embed', {
    service: args.service,
    url: args.url,
    x: args.x,
    y: args.y,
    width: args.width,
    height: args.height,
    userAgent: args.userAgent ?? null,
  });

export const webchatHide = (service: string): Promise<void> =>
  invoke('webchat_hide', { service });

export const webchatHideAll = (): Promise<void> => invoke('webchat_hide_all');

export const webchatReload = (service: string, url: string): Promise<void> =>
  invoke('webchat_reload', { service, url });

export const webchatClose = (service: string): Promise<void> =>
  invoke('webchat_close', { service });

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
