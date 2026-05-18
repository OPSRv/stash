import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';

/// A single dev-utility tile rendered inside the Dev tab grid.
///
/// Tools are pure frontend until they need otherwise — most utilities
/// (SVG → Image, base64, JWT, regex tester, etc.) can be implemented
/// without ever touching Rust. When a tool *does* need backend work it
/// still ships its own `api.ts` like any other module — the tile is
/// just a placement contract.
export interface DevTool {
  id: string;
  title: string;
  /// Short one-line description rendered under the title.
  description: string;
  /// Gradient pair for the icon tile (same convention as `StatCard`).
  gradient: [string, string];
  /// 18×18-ish glyph rendered inside the icon tile. Should use
  /// `currentColor` — the tile forces white for contrast.
  icon: ReactNode;
  /// Tool view. Lazy-loaded so a 12-tool grid doesn't drag every
  /// tool's chunk into the main popup bundle.
  View: ComponentType | LazyExoticComponent<ComponentType>;
}
