interface IconProps {
  size?: number;
  className?: string;
}

const baseProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export const LinkIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5" />
  </svg>
);

export const ExternalIcon = ({ size = 13, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M14 4h6v6" />
    <path d="M10 14 20 4" />
    <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
  </svg>
);

export const CloseIcon = ({ size = 13, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const CheckIcon = ({ size = 12, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const PlayIcon = ({ size = 13, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);

export const PauseIcon = ({ size = 13, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="currentColor">
    <rect x="6" y="5" width="4" height="14" />
    <rect x="14" y="5" width="4" height="14" />
  </svg>
);

export const PrevIcon = ({ size = 13, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
  </svg>
);

export const NextIcon = ({ size = 13, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" />
  </svg>
);

export const PinIcon = ({
  size = 14,
  className,
  filled = false,
}: IconProps & { filled?: boolean }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    className={className}
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 17v5" />
    <path d="M9 3h6l-1 6 3 3H7l3-3-1-6z" />
  </svg>
);

export const CodeIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="m8 6-6 6 6 6" />
    <path d="m16 6 6 6-6 6" />
  </svg>
);

export const CodeBlockIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m9 10-2 2 2 2" />
    <path d="m15 10 2 2-2 2" />
  </svg>
);

export const BoldIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />
  </svg>
);

export const ItalicIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M14 5h5M6 19h5M15 5 10 19" />
  </svg>
);

export const Heading1Icon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 5v14M13 5v14M5 12h8" />
    <path d="M17 8.5 19 7v12" />
  </svg>
);

export const Heading2Icon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5v14M11 5v14M4 12h7" />
    <path d="M15 9a2.5 2.5 0 1 1 5 0c0 1.5-1 2.5-2.5 3.8L15 19h5" />
  </svg>
);

export const BulletListIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M9 6h12M9 12h12M9 18h12" />
    <circle cx="4" cy="6" r="1" fill="currentColor" />
    <circle cx="4" cy="12" r="1" fill="currentColor" />
    <circle cx="4" cy="18" r="1" fill="currentColor" />
  </svg>
);

export const OrderedListIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M10 6h11M10 12h11M10 18h11" />
    <path d="M4 4v4M3 8h2M3 14h3l-3 4h3" />
  </svg>
);

export const ChecklistIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <rect x="3" y="4" width="6" height="6" rx="1.2" />
    <rect x="3" y="14" width="6" height="6" rx="1.2" />
    <path d="m4.5 17 1.2 1.2L8 16" />
    <path d="M12 7h9M12 17h9" />
  </svg>
);

export const QuoteIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M7 7H4v5h3a2 2 0 0 1-2 2v2a4 4 0 0 0 4-4V7zM18 7h-3v5h3a2 2 0 0 1-2 2v2a4 4 0 0 0 4-4V7z" />
  </svg>
);

export const EyeIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const NoteIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
    <path d="M9 13h6M9 17h4" />
  </svg>
);

export const MagicWandIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M15 4 4 15l5 5L20 9z" />
    <path d="M14 5l5 5" />
    <path d="M19 3v3M21 5h-3M4 4v2M5 5H3M19 18v2M20 19h-2" />
  </svg>
);

export const TrashIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 13h10l1-13" />
  </svg>
);

export const DownloadIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M12 4v12m0 0-4-4m4 4 4-4M5 20h14" />
  </svg>
);

export const UploadIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M12 20V8m0 0-4 4m4-4 4 4M5 4h14" />
  </svg>
);

export const SpeakerIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M11 5 6 9H3v6h3l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);

export const SwapIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M4 7h14m0 0-4-4m4 4-4 4M20 17H6m0 0 4 4m-4-4 4-4" />
  </svg>
);

export const SearchIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const ReuseIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);

export const HistoryIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const MicIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </svg>
);

export const StopCircleIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <circle cx="12" cy="12" r="9" />
    <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
  </svg>
);

export const CopyIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

export const SendToAiIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M4 12 20 4l-4 16-4-7z" />
    <path d="M12 13 8 17" />
  </svg>
);

export const PencilIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);

export const SplitViewIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </svg>
);

export const PanelLeftIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
);

export const WaveformIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M4 10v4" />
    <path d="M8 7v10" />
    <path d="M12 4v16" />
    <path d="M16 7v10" />
    <path d="M20 10v4" />
  </svg>
);

export const TranslateIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...baseProps}>
    <path d="M4 5h7M7 4v2M5 11s1.5 4 5 4M11 11s-1.5 4-5 4" />
    <path d="M13 19l4-9 4 9M14.5 16h5" />
  </svg>
);
