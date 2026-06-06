import { changeModel, changeParam, toggleBlock } from '../lib/actions';
import { type BlockConfig, modelsFor } from '../lib/blocks';
import type { ParamDef } from '../lib/constants';
import { paramDefs } from '../lib/protocol';
import { useStore } from '../store/store';
import { IconPicker } from './IconPicker';
import { Knob } from './ui/Knob';
import { ParamToggle } from './ui/ParamToggle';
import { Select } from './ui/Select';
import { ToggleSwitch } from './ui/ToggleSwitch';

const isBinary = (def: ParamDef) =>
  def[3] === 0 && def[4] === 1 && def[5] === 1;

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

  return (
    <div
      className="card relative overflow-hidden p-4 lg:flex lg:h-full lg:flex-col"
      data-id={`${key}_card`}
    >
      <span className="absolute inset-x-0 top-0 h-0.5 bg-linear-to-r from-ve-accent to-transparent opacity-50" />
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

      {block.hasPicker && (
        <div className="mt-3 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
          {block.defaultIcon ? (
            // динамічні текстові списки з однаковими іконками (N>S) → компактний select
            <Select
              value={selected}
              options={models.map((m) => ({ value: m.value, label: m.text }))}
              disabled={locked || models.length === 0}
              dataId={`${key}_effects_list`}
              placeholder={models.length ? '—' : 'No models'}
              onChange={(v) => changeModel(key, v)}
            />
          ) : (
            <IconPicker
              block={block}
              models={models}
              selected={selected}
              disabled={locked}
            />
          )}
        </div>
      )}

      {hasParams && (
        <div className="mt-4 rounded-xl border border-ve-stroke bg-ve-bg-1/60 p-4 lg:mt-auto">
          <span className="field-label mb-3 block text-center">Parameters</span>
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
    </div>
  );
};
