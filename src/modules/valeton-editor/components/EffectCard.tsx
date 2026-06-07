import { changeModel, changeParam, toggleBlock } from '../lib/actions';
import { type BlockConfig, modelsFor } from '../lib/blocks';
import type { ParamDef } from '../lib/constants';
import { paramDefs } from '../lib/protocol';
import { useStore } from '../store/store';
import { IconPicker } from './IconPicker';
import { TempoBar } from './TempoBar';
import { Knob } from './ui/Knob';
import { ParamToggle } from './ui/ParamToggle';
import { ToggleSwitch } from './ui/ToggleSwitch';

const isBinary = (def: ParamDef) =>
  def[3] === 0 && def[4] === 1 && def[5] === 1;

const Arrow = ({ dir }: { dir: 'prev' | 'next' }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d={dir === 'prev' ? 'M10 4l-4 4 4 4' : 'M6 4l4 4-4 4'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Параметр-перелік: у підписі список варіантів через " / " (напр.
   "MidFreq 220Hz / 450Hz / …"). Перший токен — назва + перший варіант. */
const enumParts = (label: string) => {
  const parts = label.split(' / ').map((s) => s.trim());
  if (parts.length < 2) return null;
  const sp = parts[0].lastIndexOf(' ');
  const name = sp > 0 ? parts[0].slice(0, sp) : parts[0];
  const first = sp > 0 ? parts[0].slice(sp + 1) : parts[0];
  return { name, options: [first, ...parts.slice(1)] };
};

/** Картка одного блока ефекту: перемикач, пікер моделей, ручки/перемикачі параметрів. */
export const EffectCard = ({ block }: { block: BlockConfig }) => {
  const { index, key } = block;
  const locked = useStore((s) => s.locked);
  const enabled = useStore((s) => s.enabled[index]);
  const selected = useStore((s) => s.selected[index]);
  const params = useStore((s) => s.params[index]);
  const cabModels = useStore((s) => s.cabModels);
  const nsModels = useStore((s) => s.nsModels);

  const defs = paramDefs(index, selected);
  const models = modelsFor(block, cabModels, nsModels);
  const hasParams = defs.some((def) => def[0]);
  const hasNav = block.hasPicker && models.length > 1;

  // Циклічний крок по моделях (за краєм → інший кінець). Раніше жив у
  // IconPicker; піднятий сюди, щоб стрілки стояли в рядку з назвою блока.
  const stepModel = (dir: 1 | -1) => {
    if (models.length <= 1) return;
    const i = models.findIndex((m) => m.value === selected);
    const base = i < 0 ? 0 : i;
    const next = (base + dir + models.length) % models.length;
    changeModel(key, models[next].value);
  };

  return (
    <div
      className="card relative overflow-hidden p-4 lg:flex lg:h-full lg:flex-col"
      data-id={`${key}_card`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <ToggleSwitch
            checked={enabled}
            disabled={locked}
            dataId={`${key}_switch`}
            label={`${block.label} on/off`}
            tone="on"
            size={34}
            onChange={(on) => toggleBlock(key, on)}
          />
          <span className="text-sm font-semibold tracking-wide text-ve-text">
            {block.label}
          </span>
        </div>
        {hasNav && (
          <div className="flex gap-1">
            <button
              type="button"
              className="icon-nav"
              data-id={`${key}_prev`}
              disabled={locked}
              aria-label="Previous model"
              onClick={() => stepModel(-1)}
            >
              <Arrow dir="prev" />
            </button>
            <button
              type="button"
              className="icon-nav"
              data-id={`${key}_next`}
              disabled={locked}
              aria-label="Next model"
              onClick={() => stepModel(1)}
            >
              <Arrow dir="next" />
            </button>
          </div>
        )}
      </div>

      {block.hasPicker && (
        <div className="mt-3 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
          {/* всі блоки (включно з N>S / NAM-профілями) — сітка плиток + prev/next.
             Для defaultIcon-блоків кожна плитка ділить один арт (ns.svg = NAM-кубик),
             а підписом служить назва профілю. */}
          <IconPicker
            block={block}
            models={models}
            selected={selected}
            disabled={locked}
          />
        </div>
      )}

      {hasParams && (
        <div className="ve-well mt-4 rounded-xl p-4">
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-5">
            {defs.map((def, i) => {
              if (!def[0]) return null;
              const value = params?.[i] ?? def[2];
              const en = enumParts(def[1]);
              if (en) {
                const idx = Math.round((value - def[3]) / def[5]);
                return (
                  <Knob
                    key={i}
                    label={en.name}
                    display={(en.options[idx] ?? '').toUpperCase()}
                    value={value}
                    min={def[3]}
                    max={def[4]}
                    step={def[5]}
                    disabled={locked}
                    dataId={`${key}_p${i}_value`}
                    onChange={(v) => changeParam(key, i, v)}
                  />
                );
              }
              return isBinary(def) ? (
                <ParamToggle
                  key={i}
                  label={def[1]}
                  value={value}
                  disabled={locked}
                  dataId={`${key}_p${i}_value`}
                  onChange={(v) => changeParam(key, i, v)}
                />
              ) : (
                <Knob
                  key={i}
                  label={def[1]}
                  value={value}
                  min={def[3]}
                  max={def[4]}
                  step={def[5]}
                  disabled={locked}
                  dataId={`${key}_p${i}_value`}
                  onChange={(v) => changeParam(key, i, v)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Темпо delay-блока: division/BPM керують часом затримки */}
      {key === 'dly' && <TempoBar />}
    </div>
  );
};
