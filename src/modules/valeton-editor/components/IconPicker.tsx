import { useEffect, useRef } from 'react';
import { changeModel } from '../lib/actions';
import { type BlockConfig, fallbackIcon, iconSrc, type ModelOption } from '../lib/blocks';

interface Props {
  block: BlockConfig;
  models: ModelOption[];
  selected: number;
  disabled: boolean;
}

/** Сітка плиток-моделей на всю ширину. Клік по плитці → changeModel; стор
   оновлює всі місця синхронно. Prev/next-навігація живе в заголовку картки
   (`EffectCard`), щоб стрілки стояли в один рядок із назвою блока. */
export const IconPicker = ({ block, models, selected, disabled }: Props) => {
  const gridRef = useRef<HTMLDivElement>(null);

  // тримати вибрану плитку в полі зору
  useEffect(() => {
    gridRef.current
      ?.querySelector('.icon-tile.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div className="flex min-h-0 flex-col lg:h-full">
      <div
        ref={gridRef}
        className="grid auto-rows-min content-start max-h-[360px] gap-2.5 overflow-y-auto pb-2 [grid-template-columns:repeat(auto-fill,minmax(104px,1fr))] lg:max-h-none lg:min-h-0 lg:flex-1"
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
