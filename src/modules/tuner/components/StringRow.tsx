import { Led } from '../../../shared/ui/pedal/Led';
import type { Tuning } from '../tuner.constants';

/* The selected tuning's strings as a row of LED cells, lowest → highest. The
 * string the tuner is currently hearing lights up — green when it's in tune,
 * amber while it's still off. Purely a status display (auto-detect mode), so
 * the cells aren't interactive. */

type Props = {
  tuning: Tuning;
  /** Index of the matched string, or -1 when silent. */
  activeIndex: number;
  inTune: boolean;
};

export const StringRow = ({ tuning, activeIndex, inTune }: Props) => (
  <div className="flex items-stretch justify-center gap-1.5">
    {tuning.strings.map((s, i) => {
      const active = i === activeIndex;
      const state = !active ? 'idle' : inTune ? 'tuned' : 'off';
      const letter = s.name.replace(/\d+$/, '');
      const octave = s.name.match(/\d+$/)?.[0] ?? '';
      return (
        <div key={s.midi} className="tuner-string" data-state={state} aria-hidden="true">
          <Led size={9} on={active} color={inTune ? 'green' : 'amber'} />
          <span className="tuner-string-note">
            {letter}
            <span className="tuner-string-oct">{octave}</span>
          </span>
        </div>
      );
    })}
  </div>
);
