import { Led } from '../../../shared/ui/pedal/Led';

type Props = {
  numerator: number;
  accents: boolean[];
  activeBeat: number;
  onToggleAccent: (idx: number) => void;
};

export const BeatStrip = ({ numerator, accents, activeBeat, onToggleAccent }: Props) => {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2" data-testid="beat-strip">
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
            className="rounded-full p-0.5 transition-transform hover:scale-110"
            data-testid={`beat-dot-${i}`}
          >
            <Led
              size={14}
              on={active}
              ring={isAccent}
              color={isAccent ? 'blue' : 'green'}
            />
          </button>
        );
      })}
    </div>
  );
};
