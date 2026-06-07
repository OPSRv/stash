import { useEffect, useRef } from 'react';
import { changeModel } from '../lib/actions';
import { type BlockConfig, fallbackIcon, iconSrc, type ModelOption } from '../lib/blocks';

interface Props {
  block: BlockConfig;
  models: ModelOption[];
  selected: number;
  disabled: boolean;
}

const Arrow = ({ dir }: { dir: 'prev' | 'next' }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
  >
    <path
      d={dir === 'prev' ? 'M10 4l-4 4 4 4' : 'M6 4l4 4-4 4'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Сітка плиток-моделей на всю ширину + кнопки prev/next з циклічним
   перемиканням. Клік/кнопка → changeModel; стор оновлює всі місця синхронно. */
export const IconPicker = ({ block, models, selected, disabled }: Props) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const idx = models.findIndex((m) => m.value === selected);

  // циклічний крок по моделях (за межами краю → інший кінець)
  const step = (dir: 1 | -1) => {
    if (!models.length) return;
    const base = idx < 0 ? 0 : idx;
    const next = (base + dir + models.length) % models.length;
    changeModel(block.key, models[next].value);
  };

  // тримати вибрану плитку в полі зору
  useEffect(() => {
    gridRef.current
      ?.querySelector('.icon-tile.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const navDisabled = disabled || models.length <= 1;

  return (
    <div className="flex min-h-0 flex-col lg:h-full">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold tracking-wide text-ve-text">
          {models[idx]?.text ?? '—'}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            className="icon-nav"
            data-id={`${block.key}_prev`}
            disabled={navDisabled}
            aria-label="Попередня модель"
            onClick={() => step(-1)}
          >
            <Arrow dir="prev" />
          </button>
          <button
            type="button"
            className="icon-nav"
            data-id={`${block.key}_next`}
            disabled={navDisabled}
            aria-label="Наступна модель"
            onClick={() => step(1)}
          >
            <Arrow dir="next" />
          </button>
        </div>
      </div>

      <div
        ref={gridRef}
        className="grid auto-rows-min content-start max-h-[360px] gap-2.5 overflow-y-auto pb-2 [grid-template-columns:repeat(auto-fill,minmax(130px,1fr))] lg:max-h-none lg:min-h-0 lg:flex-1"
        data-id={`${block.key}_icon_strip`}
        role="listbox"
        aria-label={`${block.label} model`}
      >
        {models.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`icon-tile${opt.value === selected ? ' selected' : ''}`}
            title={opt.title || opt.text}
            disabled={disabled}
            onClick={() => changeModel(block.key, opt.value)}
          >
            <img
              src={iconSrc(block, opt.value)}
              alt={opt.text}
              loading="lazy"
              onError={(e) => {
                const img = e.currentTarget;
                img.onerror = null;
                img.src = fallbackIcon(block.key);
              }}
            />
            <span>{opt.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
