type Props = {
  numerator: number;
  accents: boolean[];
  activeBeat: number;
  onToggleAccent: (idx: number) => void;
};

export const BeatStrip = ({ numerator, accents, activeBeat, onToggleAccent }: Props) => {
  return (
    <div className="flex items-center justify-center gap-3" data-testid="beat-strip">
      {Array.from({ length: numerator }, (_, i) => {
        const accent = accents[i] ?? false;
        const active = i === activeBeat;
        const size = accent ? 14 : 10;
        return (
          <button
            key={i}
            type="button"
            role="switch"
            aria-checked={accent}
            aria-label={`Beat ${i + 1}${accent ? ' (accent)' : ''}`}
            onClick={() => onToggleAccent(i)}
            className="p-1 transition-transform hover:scale-110"
            data-testid={`beat-dot-${i}`}
          >
            <span
              className="block"
              style={{
                width: size,
                height: size,
                transform: accent ? 'rotate(45deg)' : undefined,
                background: active
                  ? 'rgba(var(--stash-accent-rgb), 1)'
                  : accent
                    ? 'rgba(var(--stash-accent-rgb), 0.4)'
                    : 'rgba(255,255,255,0.18)',
                borderRadius: accent ? 2 : 999,
                boxShadow: active
                  ? '0 0 12px rgba(var(--stash-accent-rgb), 0.7)'
                  : undefined,
                transition: 'background 120ms ease, box-shadow 120ms ease',
              }}
            />
          </button>
        );
      })}
    </div>
  );
};
