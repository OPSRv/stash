import type { Preview, Decorator } from '@storybook/react-vite';
import { withThemeByClassName } from '@storybook/addon-themes';
import { useEffect } from 'react';

import '../src/styles/tokens.css';
import './preview.css';

type AccentKey = 'stash' | 'violet' | 'emerald' | 'amber' | 'rose' | 'cyan';

const ACCENTS: Record<AccentKey, { rgb: string; hex: string; label: string }> = {
  stash: { rgb: '47, 122, 229', hex: '#2f7ae5', label: 'Stash (blue)' },
  violet: { rgb: '139, 92, 246', hex: '#8b5cf6', label: 'Violet' },
  emerald: { rgb: '16, 185, 129', hex: '#10b981', label: 'Emerald' },
  amber: { rgb: '245, 158, 11', hex: '#f59e0b', label: 'Amber' },
  rose: { rgb: '244, 63, 94', hex: '#f43f5e', label: 'Rose' },
  cyan: { rgb: '6, 182, 212', hex: '#06b6d4', label: 'Cyan' },
};

const withAccent: Decorator = (Story, ctx) => {
  const key = (ctx.globals.accent as AccentKey) ?? 'stash';
  const a = ACCENTS[key] ?? ACCENTS.stash;
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--stash-accent-rgb', a.rgb);
    root.style.setProperty('--stash-accent', a.hex);
  }, [a.rgb, a.hex]);
  return <Story />;
};

const withSurface: Decorator = (Story, ctx) => {
  const surface = (ctx.globals.surface as 'pane' | 'plain' | 'grid') ?? 'pane';
  const cls =
    surface === 'pane'
      ? 'pane rounded-xl p-5'
      : surface === 'grid'
      ? 'canvas-grid rounded-xl p-5'
      : 'p-5';
  return (
    <div className="sb-stage">
      <div className={cls}>
        <Story />
      </div>
    </div>
  );
};

const preview: Preview = {
  globalTypes: {
    accent: {
      description: 'Accent colour (maps to --stash-accent-rgb)',
      defaultValue: 'stash',
      toolbar: {
        title: 'Accent',
        icon: 'paintbrush',
        items: (Object.keys(ACCENTS) as AccentKey[]).map((k) => ({
          value: k,
          title: ACCENTS[k].label,
        })),
        dynamicTitle: true,
      },
    },
    surface: {
      description: 'Stage surface',
      defaultValue: 'pane',
      toolbar: {
        title: 'Surface',
        icon: 'box',
        items: [
          { value: 'pane', title: 'Translucent pane' },
          { value: 'plain', title: 'Plain (no pane)' },
          { value: 'grid', title: 'Canvas grid' },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    layout: 'centered',
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
      expanded: true,
    },
    backgrounds: {
      default: 'canvas-dark',
      values: [
        { name: 'canvas-dark', value: '#0b0b0e' },
        { name: 'canvas-light', value: '#eceef2' },
        { name: 'menubar-wallpaper', value: 'linear-gradient(135deg,#1b2a49,#3a1e5c 55%,#0d1a2a)' },
      ],
    },
    options: {
      storySort: {
        order: [
          'Intro',
          'Primitives',
          ['Button', 'IconButton', 'Toggle', 'SegmentedControl', 'TabButton'],
          'Inputs',
          'Feedback',
          'Surfaces',
          'Overlays',
          'Typography',
        ],
      },
    },
  },
  decorators: [
    withAccent,
    withSurface,
    withThemeByClassName({
      themes: { dark: '', light: 'light' },
      defaultTheme: 'dark',
      parentSelector: 'html',
    }),
  ],
};

export default preview;
