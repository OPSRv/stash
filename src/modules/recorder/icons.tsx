/// Mode picker icons for the Recorder. Data-level SVG constants — grouped
/// in one file because they share the same stroke/viewBox setup and are
/// only consumed by RecorderShell's mode SegmentedControl.

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const ScreenIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" strokeWidth="1.5" {...strokeProps}>
    <rect x="2" y="4" width="20" height="14" rx="2" />
    <path d="M8 22h8M12 18v4" />
  </svg>
);

export const ScreenCamIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" strokeWidth="1.5" {...strokeProps}>
    <rect x="2" y="4" width="20" height="14" rx="2" />
    <circle cx="17" cy="15" r="3" fill="currentColor" fillOpacity="0.2" />
  </svg>
);

export const CamIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" strokeWidth="1.5" {...strokeProps}>
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </svg>
);

export const AudioSpeakerIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" strokeWidth="1.6" {...strokeProps}>
    <path d="M11 5 6 9H3v6h3l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);

export const MuteIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" strokeWidth="1.6" {...strokeProps}>
    <path d="M11 5 6 9H3v6h3l5 4V5z" />
    <path d="m17 9 5 5M22 9l-5 5" />
  </svg>
);
