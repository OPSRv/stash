import { Badge } from '../../shared/ui/Badge';
import { platformBadge } from './api';

type PlatformBadgeProps = {
  platform: string;
};

export const PlatformBadge = ({ platform }: PlatformBadgeProps) => {
  const { label, bg, fg } = platformBadge(platform);
  return (
    <Badge color={fg} bg={bg}>
      {label}
    </Badge>
  );
};
