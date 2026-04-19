import { LevelMeter } from './LevelMeter';
import { AudioSpeakerIcon, MuteIcon } from './icons';

interface AudioSourceRowProps {
  name: string;
  enabled: boolean;
  onToggle: () => void;
  muted: boolean;
  onMuteToggle: () => void;
  gain: number;
  onGain: (next: number) => void;
  level: number;
  removable?: boolean;
}

/// Mixer row: left toggle for track on/off, mute icon, name, live wbar meter,
/// gain slider (0–200%), % label. Follows the design's "compact horizontal
/// audio pill" feel inside a vertical list.
export const AudioSourceRow = ({
  name,
  enabled,
  onToggle,
  muted,
  onMuteToggle,
  gain,
  onGain,
  level,
  removable,
}: AudioSourceRowProps) => {
  const percent = Math.round(gain * 100);
  return (
    <div
      className="flex items-center gap-2 py-1.5 px-2 rounded-md"
      style={{ background: enabled ? 'rgba(255,255,255,0.03)' : 'transparent' }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`Enable ${name}`}
        onClick={onToggle}
        className="relative w-[28px] h-[16px] rounded-full transition shrink-0"
        style={{
          background: enabled ? 'var(--stash-accent)' : 'rgba(255,255,255,0.12)',
        }}
      >
        <span
          className="absolute top-[2px] w-3 h-3 bg-white rounded-full shadow transition-[left]"
          style={{ left: enabled ? 13 : 2 }}
        />
      </button>
      <button
        type="button"
        onClick={onMuteToggle}
        disabled={!enabled}
        aria-label={muted ? 'Unmute' : 'Mute'}
        className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 disabled:opacity-40"
        style={{
          background: muted ? 'var(--color-danger-bg)' : 'rgba(255,255,255,0.04)',
          color: muted ? 'var(--color-danger-fg)' : 'rgba(255,255,255,0.6)',
        }}
      >
        {muted ? <MuteIcon /> : <AudioSpeakerIcon />}
      </button>
      <span
        className="t-primary text-body truncate"
        style={{ flex: '1 1 0', minWidth: 60 }}
      >
        {name}
      </span>
      <div className="shrink-0">
        <LevelMeter
          level={enabled && !muted ? level : 0}
          muted={muted || !enabled}
          height={12}
          bars={6}
        />
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={1}
        value={percent}
        onChange={(e) => onGain(Number(e.target.value) / 100)}
        disabled={!enabled}
        aria-label={`${name} gain`}
        className="stash-fader shrink-0"
        style={{ width: 96 }}
      />
      <span
        className="t-tertiary text-meta font-mono tabular-nums shrink-0"
        style={{ width: 34, textAlign: 'right' }}
      >
        {percent}%
      </span>
      {removable && (
        <button
          type="button"
          onClick={onToggle}
          aria-label={`Remove ${name}`}
          className="t-tertiary hover:t-primary w-5 h-5 rounded flex items-center justify-center shrink-0"
          title="Remove"
        >
          ×
        </button>
      )}
    </div>
  );
};
