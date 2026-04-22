import { accent as accentColor } from '../../../shared/theme/accent';

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
        const isAccent = accents[i] ?? false;
        const active = i === activeBeat;
        const size = isAccent ? 14 : 10;
        return (
          <button
            key={i}
            type="button"
            role="switch"
            aria-checked={isAccent}
            aria-label={`Beat ${i + 1}${isAccent ? ' (accent)' : ''}`}
            onClick={() => onToggleAccent(i)}
            className="p-1 transition-transform hover:scale-110"
            data-testid={`beat-dot-${i}`}
          >
            <span
              className="block"
              style={{
                width: size,
                height: size,
                transform: isAccent ? 'rotate(45deg)' : undefined,
                background: active
                  ? accentColor(1)
                  : isAccent
                    ? accentColor(0.4)
                    : 'rgba(255,255,255,0.18)',
                borderRadius: isAccent ? 2 : 999,
                boxShadow: active ? `0 0 12px ${accentColor(0.7)}` : undefined,
                transition: 'background 120ms ease, box-shadow 120ms ease',
              }}
            />
          </button>
        );
      })}
    </div>
  );
};
