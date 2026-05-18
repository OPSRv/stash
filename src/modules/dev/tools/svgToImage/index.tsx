import { lazy } from 'react';
import type { DevTool } from '../../types';

const load = () =>
  import('./SvgToImageTool').then((m) => ({ default: m.SvgToImageTool }));

export const svgToImageTool: DevTool = {
  id: 'svg-to-image',
  title: 'SVG → Image',
  description: 'Paste SVG markup, download as PNG, JPG or WebP.',
  gradient: ['#22d3ee', '#6366f1'],
  icon: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M8 13l3 3 5-6" />
    </svg>
  ),
  View: lazy(load),
};
