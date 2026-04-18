import { platformBadge } from './api';

type PlatformBadgeProps = {
  platform: string;
};

export const PlatformBadge = ({ platform }: PlatformBadgeProps) => {
  const { label, bg, fg } = platformBadge(platform);
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[10px] font-medium"
      style={{ background: bg, color: fg }}
    >
      {label}
    </span>
  );
};
