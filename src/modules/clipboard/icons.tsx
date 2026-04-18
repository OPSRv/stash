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

export const typeTint: Record<ContentType, { bg: string; fg: string }> = {
  link: { bg: 'rgba(47,122,229,0.10)', fg: '#4A8BEA' },
  code: { bg: 'rgba(180,120,255,0.10)', fg: '#B48BFF' },
  image: { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.85)' },
  text: { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.85)' },
};

export const iconFor = (type: ContentType) => {
  switch (type) {
    case 'link':
      return <LinkIcon />;
    case 'code':
      return <CodeIcon />;
    case 'image':
      return <ImageIcon />;
    default:
      return <TextIcon />;
  }
};
