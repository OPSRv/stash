import type { ReactNode } from 'react';
import type { ContentType, TextSubtype } from './contentType';

const iconProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const TextIcon = () => (
  <svg {...iconProps}>
    <path d="M5 6h14M5 12h14M5 18h10" />
  </svg>
);

export const LinkIcon = () => (
  <svg {...iconProps}>
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5" />
  </svg>
);

export const CodeIcon = () => (
  <svg {...iconProps}>
    <path d="m8 6-6 6 6 6" />
    <path d="m16 6 6 6-6 6" />
  </svg>
);

export const ImageIcon = () => (
  <svg {...iconProps}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </svg>
);

export const FileIcon = () => (
  <svg {...iconProps}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

export const typeTint: Record<ContentType, { bg: string; fg: string }> = {
  link: { bg: 'rgba(47,122,229,0.10)', fg: '#4A8BEA' },
  code: { bg: 'rgba(180,120,255,0.10)', fg: '#B48BFF' },
  image: { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.85)' },
  text: { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.85)' },
  // Warm amber tint — visually distinct from image/text so multi-file
  // Finder copies pop out of a busy list without stealing focus from
  // the accent-coloured link rows.
  file: { bg: 'rgba(255,176,64,0.12)', fg: '#E8A25A' },
};

export const iconFor = (type: ContentType) => {
  switch (type) {
    case 'link':
      return <LinkIcon />;
    case 'code':
      return <CodeIcon />;
    case 'image':
      return <ImageIcon />;
    case 'file':
      return <FileIcon />;
    default:
      return <TextIcon />;
  }
};

// ---- text-subtype visuals -------------------------------------------------

export const EmailIcon = () => (
  <svg {...iconProps}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </svg>
);

export const PhoneIcon = () => (
  <svg {...iconProps}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

export const HashIcon = () => (
  <svg {...iconProps}>
    <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
  </svg>
);

export const BraceIcon = () => (
  <svg {...iconProps}>
    <path d="M8 3H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2M16 3h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2" />
  </svg>
);

export const FolderPathIcon = () => (
  <svg {...iconProps}>
    <path d="M4 4h5l2 2h9v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
  </svg>
);

export const LockIcon = () => (
  <svg {...iconProps}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

/// Per-subtype visuals for `kind='text'` rows. `plain` keeps the
/// original text-row tint so ordinary prose looks exactly like it did
/// before we introduced subtypes.
export const subtypeVisual: Record<
  TextSubtype,
  { icon: () => ReactNode; tint: { bg: string; fg: string } }
> = {
  plain: {
    icon: TextIcon,
    tint: typeTint.text,
  },
  email: {
    icon: EmailIcon,
    tint: { bg: 'rgba(80,200,120,0.12)', fg: '#6FD39B' },
  },
  phone: {
    icon: PhoneIcon,
    tint: { bg: 'rgba(80,200,120,0.12)', fg: '#6FD39B' },
  },
  'hex-color': {
    // Tint is overridden inline with the actual colour value so the
    // user sees the shade right away.
    icon: HashIcon,
    tint: { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.85)' },
  },
  uuid: {
    icon: HashIcon,
    tint: { bg: 'rgba(180,120,255,0.08)', fg: '#B48BFF' },
  },
  json: {
    icon: BraceIcon,
    tint: { bg: 'rgba(180,120,255,0.10)', fg: '#B48BFF' },
  },
  'file-path': {
    icon: FolderPathIcon,
    tint: typeTint.file,
  },
  secret: {
    icon: LockIcon,
    // Red-ish tint telegraphs "be careful with this" without being
    // as loud as destructive-action red.
    tint: { bg: 'rgba(239, 68, 68, 0.12)', fg: '#E56B6B' },
  },
};
