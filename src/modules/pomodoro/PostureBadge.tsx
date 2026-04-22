import type { Posture } from './api';
import { POSTURE_LABEL } from './constants';

/// Small pill rendering the posture's label + emoji. Colors ride the accent
/// token so light/dark themes both look right without extra CSS.
const STYLES: Record<Posture, { bg: string; fg: string; emoji: string }> = {
  sit: { bg: 'rgba(120, 130, 160, 0.18)', fg: 'rgba(200,210,230,0.95)', emoji: '💺' },
  stand: { bg: 'rgba(110, 170, 130, 0.22)', fg: 'rgba(180,230,200,0.95)', emoji: '🧍' },
  walk: { bg: 'rgba(200, 150, 90, 0.22)', fg: 'rgba(240,210,160,0.95)', emoji: '🚶' },
};

interface PostureBadgeProps {
  posture: Posture;
  size?: 'sm' | 'md';
}

export const PostureBadge = ({ posture, size = 'sm' }: PostureBadgeProps) => {
  const style = STYLES[posture];
  const px = size === 'md' ? 'px-2 py-1 text-meta' : 'px-1.5 py-0.5 text-meta';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded font-medium ${px}`}
      style={{ background: style.bg, color: style.fg }}
      aria-label={`Posture: ${POSTURE_LABEL[posture]}`}
    >
      <span aria-hidden>{style.emoji}</span>
      {POSTURE_LABEL[posture]}
    </span>
  );
};
