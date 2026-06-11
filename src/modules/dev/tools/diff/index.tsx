import { lazy } from 'react';
import type { DevTool } from '../../types';

const load = () =>
  import('./DiffTool').then((m) => ({ default: m.DiffTool }));

export const diffTool: DevTool = {
  id: 'diff',
  title: 'Compare',
  description: 'Diff two texts — code line-by-line or JSON as a structural tree.',
  gradient: ['#34d399', '#0ea5e9'],
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
      <path d="M5 3v14a2 2 0 0 0 2 2h4" />
      <path d="M9 7h6" />
      <path d="M19 21V7a2 2 0 0 0-2-2h-4" />
      <path d="M15 17H9" />
    </svg>
  ),
  View: lazy(load),
};
