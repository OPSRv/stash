import { accent } from '../../shared/theme/accent';

/** Annotation palette + a native colour well for custom picks. There is no
 *  shared colour-picker primitive in the app (accent uses fixed swatches), and
 *  an image editor genuinely needs arbitrary colours — so this module-local
 *  field is the single reuse point across the Inspector and Backdrop controls. */
export const PALETTE = [
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#34c759',
  '#007aff',
  '#5856d6',
  '#af52de',
  '#111111',
  '#8e8e93',
  '#ffffff',
];

interface Props {
  label?: string;
  value: string;
  onChange: (hex: string) => void;
  /** Show a "transparent" option (for shape fills). */
  allowTransparent?: boolean;
}

export const ColorField = ({ label, value, onChange, allowTransparent }: Props) => (
  <div className="flex flex-col gap-1.5">
    {label && <span className="text-meta t-tertiary">{label}</span>}
    <div className="flex flex-wrap items-center gap-1.5">
      {allowTransparent && (
        <button
          type="button"
          onClick={() => onChange('transparent')}
          title="Transparent"
          aria-label="Transparent"
          aria-pressed={value === 'transparent'}
          className="h-5 w-5 rounded-md border hair"
          style={{
            background:
              'repeating-conic-gradient(#bbb 0% 25%, #fff 0% 50%) 50% / 8px 8px',
            boxShadow: value === 'transparent' ? `0 0 0 2px ${accent(0.9)}` : undefined,
          }}
        />
      )}
      {PALETTE.map((hex) => (
        <button
          key={hex}
          type="button"
          onClick={() => onChange(hex)}
          title={hex}
          aria-label={hex}
          aria-pressed={value.toLowerCase() === hex.toLowerCase()}
          className="h-5 w-5 rounded-md border hair"
          style={{
            background: hex,
            boxShadow:
              value.toLowerCase() === hex.toLowerCase()
                ? `0 0 0 2px ${accent(0.9)}`
                : undefined,
          }}
        />
      ))}
      <label
        className="relative h-5 w-5 cursor-pointer overflow-hidden rounded-md border hair"
        title="Custom colour"
        style={{
          background:
            'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
        }}
      >
        <input
          type="color"
          value={value === 'transparent' ? '#ffffff' : value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label="Custom colour"
        />
      </label>
    </div>
  </div>
);
