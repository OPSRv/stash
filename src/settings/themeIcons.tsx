/// Theme-mode icons (Sun / Moon / Auto) used only by the Appearance tab.

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const SunIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden {...strokeProps}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

export const MoonIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden {...strokeProps}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

export const AutoIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden {...strokeProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18" />
  </svg>
);
