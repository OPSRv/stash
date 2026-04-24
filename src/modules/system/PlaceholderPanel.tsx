import type { NavItem } from './SystemShell';

/// Rich "coming soon" state for un-implemented sub-tabs — reuses the tile's
/// own gradient so each stub still feels like a distinct CleanMyMac-style
/// tool rather than a blank screen.
export const PlaceholderPanel = ({ item }: { item: NavItem }) => (
  <div className="flex-1 min-h-0 overflow-auto p-6">
    <div
      className="relative overflow-hidden rounded-2xl p-6 flex items-center gap-4"
      style={{
        background: `linear-gradient(135deg, ${item.gradient[0]}22, ${item.gradient[1]}33)`,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
      }}
    >
      <div
        aria-hidden
        className="absolute -top-10 -right-10 w-40 h-40 rounded-full"
        style={{
          background: `radial-gradient(closest-side, ${item.gradient[1]}55, transparent)`,
          filter: 'blur(10px)',
        }}
      />
      <div
        aria-hidden
        className="w-16 h-16 rounded-2xl inline-flex items-center justify-center relative"
        style={{
          background: `linear-gradient(135deg, ${item.gradient[0]}, ${item.gradient[1]})`,
          boxShadow: `0 10px 30px -10px ${item.gradient[1]}, inset 0 0 0 1px rgba(255,255,255,0.2)`,
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d={item.glyph} />
        </svg>
      </div>
      <div className="relative flex-1">
        <div className="t-primary text-title font-semibold">{item.label}</div>
        <div className="t-secondary text-body">{item.hint}</div>
        <div className="mt-2 inline-flex items-center gap-1.5 t-tertiary text-meta">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: item.gradient[1] }}
          />
          In development — see SYSTEM_MODULE.md
        </div>
      </div>
    </div>
  </div>
);
