import { Button } from '../shared/ui/Button';
import { Surface } from '../shared/ui/Surface';
import { TrafficLights } from '../shared/ui/TrafficLights';
import { ACCENTS } from './theme';
import type { Settings } from './store';

interface AppearancePreviewProps {
  settings: Settings;
}

/// Live preview card shown at the top of the Appearance tab. Mirrors the
/// popup chrome so users see what their accent/blur/translucency look
/// like before committing.
export const AppearancePreview = ({ settings }: AppearancePreviewProps) => {
  const accent = ACCENTS[settings.themeAccent];
  return (
    <Surface rounded="2xl" className="overflow-hidden w-full">
      <div className="flex items-center px-3 py-2 border-b hair relative">
        <TrafficLights />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="t-primary text-meta font-medium">Preview</span>
        </div>
      </div>
      <div className="px-3 pt-2 pb-1">
        <span className="section-label">Recent</span>
      </div>
      <div className="mx-2 mb-1 rounded-lg flex items-center gap-2.5 px-2.5 py-2 row-active">
        <span className="t-primary text-meta truncate flex-1">Active row · uses accent</span>
        <span className="kbd">↵</span>
      </div>
      <div className="mx-2 mb-1 rounded-lg flex items-center gap-2.5 px-2.5 py-2">
        <span
          className="w-5 h-5 rounded-md inline-flex items-center justify-center shrink-0"
          style={{ background: `rgba(${accent.rgb}, 0.16)`, color: accent.hex }}
          aria-hidden
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" />
            <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5" />
          </svg>
        </span>
        <span className="t-primary text-meta truncate flex-1">Idle row · accent tint</span>
      </div>
      <div className="flex items-center justify-between px-3 py-2 border-t hair">
        <span className="t-tertiary text-meta">Sample popup</span>
        <Button size="xs" variant="solid" tone="accent">
          Action
        </Button>
      </div>
    </Surface>
  );
};
