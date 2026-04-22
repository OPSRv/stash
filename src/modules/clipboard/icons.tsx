import type { ContentType } from './contentType';

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
