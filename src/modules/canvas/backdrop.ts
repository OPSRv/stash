import type { BackdropFill } from './types';

export interface BackdropPreset {
  id: string;
  label: string;
  fill: BackdropFill;
}

/** Curated backdrop presets (Xnapper / Pika style). Solid neutrals + vivid
 *  gradients; users can still go fully custom (preset becomes '__user__'). */
export const BACKDROP_PRESETS: BackdropPreset[] = [
  { id: 'indigo-pink', label: 'Indigo · Pink', fill: { kind: 'gradient', from: '#6366f1', to: '#ec4899', angle: 135 } },
  { id: 'sky-cyan', label: 'Sky · Cyan', fill: { kind: 'gradient', from: '#0ea5e9', to: '#22d3ee', angle: 135 } },
  { id: 'sunset', label: 'Sunset', fill: { kind: 'gradient', from: '#f97316', to: '#ef4444', angle: 135 } },
  { id: 'lime-emerald', label: 'Lime · Emerald', fill: { kind: 'gradient', from: '#84cc16', to: '#059669', angle: 135 } },
  { id: 'violet-fuchsia', label: 'Violet', fill: { kind: 'gradient', from: '#8b5cf6', to: '#d946ef', angle: 135 } },
  { id: 'peach', label: 'Peach', fill: { kind: 'gradient', from: '#fbbf24', to: '#fb7185', angle: 135 } },
  { id: 'mint', label: 'Mint', fill: { kind: 'gradient', from: '#34d399', to: '#22d3ee', angle: 135 } },
  { id: 'grape', label: 'Grape', fill: { kind: 'gradient', from: '#a855f7', to: '#6366f1', angle: 135 } },
  { id: 'rose-gold', label: 'Rose Gold', fill: { kind: 'gradient', from: '#f9a8d4', to: '#fcd34d', angle: 135 } },
  { id: 'ocean', label: 'Ocean', fill: { kind: 'gradient', from: '#1e3a8a', to: '#0891b2', angle: 135 } },
  { id: 'forest', label: 'Forest', fill: { kind: 'gradient', from: '#064e3b', to: '#65a30d', angle: 135 } },
  { id: 'ember', label: 'Ember', fill: { kind: 'gradient', from: '#7c2d12', to: '#f59e0b', angle: 135 } },
  { id: 'midnight', label: 'Midnight', fill: { kind: 'gradient', from: '#0f172a', to: '#334155', angle: 135 } },
  { id: 'slate', label: 'Slate', fill: { kind: 'gradient', from: '#475569', to: '#0f172a', angle: 135 } },
  { id: 'snow', label: 'Snow', fill: { kind: 'solid', color: '#f4f4f5' } },
  { id: 'ink', label: 'Ink', fill: { kind: 'solid', color: '#18181b' } },
  { id: 'transparent', label: 'Transparent', fill: { kind: 'solid', color: 'transparent' } },
];

export const presetSwatch = (fill: BackdropFill): string =>
  fill.kind === 'solid'
    ? fill.color
    : `linear-gradient(${fill.angle}deg, ${fill.from}, ${fill.to})`;
