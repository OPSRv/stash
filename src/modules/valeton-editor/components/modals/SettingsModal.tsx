import { changeFoot, changeGlobal } from '../../lib/actions';
import { useStore } from '../../store/store';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';

const fill = (v: number, min: number, max: number) =>
  `${((v - min) / (max - min || 1)) * 100}%`;

interface RowProps {
  dataId: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}

const GlobalSlider = ({
  dataId,
  label,
  unit,
  min,
  max,
  value,
  onChange,
}: RowProps) => (
  <div className="py-2">
    <input
      type="range"
      className="range"
      data-id={dataId}
      min={min}
      max={max}
      value={value}
      style={{ ['--_fill' as string]: fill(value, min, max) }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
    <div className="mt-0.5 flex items-center justify-between">
      <span className="field-label">{label}</span>
      <span className="field-value">
        {value}
        {unit ? ` ${unit}` : ''}
      </span>
    </div>
  </div>
);

export const SettingsModal = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => {
  const globalInput = useStore((s) => s.globalInput);
  const globalCab = useStore((s) => s.globalCab);
  const globalRec = useStore((s) => s.globalRec);
  const globalBt = useStore((s) => s.globalBt);
  const globalMon = useStore((s) => s.globalMon);
  const globalFoot = useStore((s) => s.globalFoot);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Global Settings"
      dataId="settingsModal"
      footer={
        <button type="button" className="btn btn-soft" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="mb-1 text-sm text-ve-dim">Input / Output</p>
      <GlobalSlider
        dataId="global_input_value"
        label="Input level"
        unit="dB"
        min={-20}
        max={20}
        value={globalInput}
        onChange={(v) => changeGlobal('globalInput', 1, 3, v)}
      />
      <GlobalSlider
        dataId="global_nocab_value"
        label="No CAB mode"
        min={0}
        max={1}
        value={globalCab}
        onChange={(v) => changeGlobal('globalCab', 3, 3, v)}
      />

      <hr className="my-3 border-ve-stroke" />
      <p className="mb-1 text-sm text-ve-dim">USB Settings</p>
      <GlobalSlider
        dataId="global_rec_value"
        label="Rec level"
        unit="dB"
        min={-20}
        max={20}
        value={globalRec}
        onChange={(v) => changeGlobal('globalRec', 1, 4, v)}
      />
      <GlobalSlider
        dataId="global_bt_value"
        label="Bt level"
        unit="dB"
        min={-20}
        max={20}
        value={globalBt}
        onChange={(v) => changeGlobal('globalBt', 5, 4, v)}
      />
      <GlobalSlider
        dataId="global_mon_value"
        label="Mon level"
        unit="dB"
        min={-20}
        max={20}
        value={globalMon}
        onChange={(v) => changeGlobal('globalMon', 2, 4, v)}
      />

      <hr className="my-3 border-ve-stroke" />
      <p className="mb-1 text-sm text-ve-dim">Footswitch Settings</p>
      <Select
        dataId="global_foot_list"
        value={globalFoot}
        onChange={(v) => changeFoot(v)}
        options={[
          { value: 0, label: '0-99' },
          { value: 1, label: '0-9' },
          { value: 2, label: 'A-Z' },
          { value: 3, label: 'CTL' },
          { value: 4, label: 'Tuner' },
        ]}
      />
    </Modal>
  );
};
