import { PedalSelect } from '../../../shared/ui/PedalSelect';
import { shortDeviceLabel } from '../../../shared/util/deviceLabel';

/* Audio-input picker — uses the shared dark <PedalSelect> so it matches the
 * rest of the device chrome (and the tuning picker right beside it). The select
 * speaks in numeric values, so the system default maps to -1 and each real
 * device maps to its index in the list. */

type Props = {
  /** Selected device id, or null for the system default. */
  value: string | null;
  devices: MediaDeviceInfo[];
  onChange: (deviceId: string | null) => void;
};

const DEFAULT_VALUE = -1;

export const DeviceSelect = ({ value, devices, onChange }: Props) => {
  const options = [
    { value: DEFAULT_VALUE, label: 'System default' },
    ...devices.map((d, i) => ({
      value: i,
      label: d.label ? shortDeviceLabel(d.label) : `Microphone ${i + 1}`,
    })),
  ];

  const selectedIndex = value === null ? DEFAULT_VALUE : devices.findIndex((d) => d.deviceId === value);

  return (
    <PedalSelect
      dataId="tuner_device"
      className="w-full"
      value={selectedIndex < 0 ? DEFAULT_VALUE : selectedIndex}
      options={options}
      onChange={(i) => onChange(i === DEFAULT_VALUE ? null : (devices[i]?.deviceId ?? null))}
    />
  );
};
