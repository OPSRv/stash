import { PedalSelect } from '../../../shared/ui/PedalSelect';
import { TUNINGS, type Tuning } from '../tuner.constants';

/* Tuning picker — uses the shared dark <PedalSelect> so it matches the rest of
 * the device chrome. The select speaks in numeric values, so we map by index
 * into the generated TUNINGS list. */

type Props = {
  value: Tuning;
  onChange: (tuning: Tuning) => void;
};

const options = TUNINGS.map((t, i) => ({ value: i, label: t.label }));

export const TuningSelect = ({ value, onChange }: Props) => {
  const index = TUNINGS.findIndex((t) => t.id === value.id);
  return (
    <PedalSelect
      dataId="tuner_tuning"
      className="w-full"
      value={index < 0 ? 0 : index}
      options={options}
      onChange={(i) => onChange(TUNINGS[i])}
    />
  );
};
