type LevelMeterProps = {
  /** RMS level in [0..1]; modulates bar amplitude and animation speed. */
  level: number;
  bars?: number;
  height?: number;
  muted?: boolean;
};

/// Animated waveform strip built on the project-wide `.wbar` keyframe
/// (`wave-bar` in `tokens.css`). Silent sources render dimmed bars that
/// barely move; louder signal drives taller amplitude via a scaleY nudge and
/// shortens the animation duration so bars "flicker" in time with voice.
export const LevelMeter = ({
  level,
  bars = 8,
  height = 14,
  muted = false,
}: LevelMeterProps) => {
  const clamped = Math.max(0, Math.min(1, level));
  const active = !muted && clamped > 0.01;
  // Faster animation when loud — 1.1s at idle down to ~0.35s loud.
  const duration = 1.1 - 0.75 * clamped;
  // Amplitude multiplier on top of the baseline .wbar wave; a quiet signal
  // still breathes, a loud one jumps to near 1.
  const amplitude = 0.35 + 0.65 * clamped;
  const delays = [-0.9, -0.7, -0.5, -0.3, -0.1, -0.8, -0.4, -0.2];
  return (
    <div
      className="flex items-end gap-[2px]"
      style={{ height }}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={clamped}
    >
      {Array.from({ length: bars }, (_, i) => {
        const delay = delays[i % delays.length];
        return (
          <span
            key={i}
            className={active ? 'wbar rounded-full' : 'rounded-full'}
            style={{
              width: 2,
              height: Math.round(height * 0.78),
              background: muted
                ? 'rgba(255,255,255,0.14)'
                : 'rgba(var(--stash-accent-rgb), 0.9)',
              transform: active ? `scaleY(${amplitude})` : 'scaleY(0.2)',
              animationDelay: active ? `${delay}s` : undefined,
              animationDuration: active ? `${duration}s` : undefined,
              transformOrigin: 'center',
              transition: 'transform 120ms ease-out, background 120ms',
            }}
          />
        );
      })}
    </div>
  );
};
