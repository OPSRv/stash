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
        return (
          <button
            key={i}
            type="button"
            role="switch"
            aria-checked={isAccent}
            aria-label={`Beat ${i + 1}${isAccent ? ' (accent)' : ''}`}
            onClick={() => onToggleAccent(i)}
            className="p-1.5 hover:scale-110 transition-transform"
            data-testid={`beat-dot-${i}`}
          >
            <span
              className="metro-beat-dot block"
              data-accent={isAccent}
              data-active={active}
            />
          </button>
        );
      })}
    </div>
  );
};
