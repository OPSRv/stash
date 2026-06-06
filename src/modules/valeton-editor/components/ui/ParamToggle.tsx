import { ToggleSwitch } from './ToggleSwitch';

interface Props {
  label: string;
  value: number;
  disabled: boolean;
  dataId?: string;
  onChange: (value: number) => void;
}

/** Бінарний параметр (0/1) як залізний бат-тумблер — для Bright/Trail/+3DB тощо. */
export const ParamToggle = ({
  label,
  value,
  disabled,
  dataId,
  onChange,
}: Props) => (
  <div className="flex min-w-14 flex-col items-center justify-start gap-1.5 select-none">
    <span className="flex h-16 items-center">
      <ToggleSwitch
        checked={value === 1}
        disabled={disabled}
        dataId={dataId}
        label={label}
        onChange={(on) => onChange(on ? 1 : 0)}
      />
    </span>
    <span className="field-label text-center leading-tight">{label}</span>
  </div>
);
