import { lazy } from 'react';
import type { DevTool } from '../../types';

const load = () =>
  import('./JwtTool').then((m) => ({ default: m.JwtTool }));

export const jwtTool: DevTool = {
  id: 'jwt',
  title: 'JWT Decoder',
  description: 'Decode a JSON Web Token; copy header, payload, signature.',
  gradient: ['#f59e0b', '#ef4444'],
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
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  View: lazy(load),
};
