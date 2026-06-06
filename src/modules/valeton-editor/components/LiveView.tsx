import { toggleBlock } from '../lib/actions';
import { BLOCKS, fallbackIcon, iconSrc } from '../lib/blocks';
import { nextPatch, prevPatch } from '../lib/transport';
import { useStore } from '../store/store';

const LIVE_ORDER = [0, 1, 2, 9, 3, 4, 5, 6, 7, 8];

/** Live-режим: великий дисплей номера/назви пресету + перемикачі ефектів. */
export const LiveView = () => {
  const locked = useStore((s) => s.locked);
  const enabled = useStore((s) => s.enabled);
  const selected = useStore((s) => s.selected);
  const number = useStore((s) => s.currentPatchNumber);
  const name = useStore((s) => s.patchNames[s.currentPatchNumber] ?? 'GP-5');

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-stretch gap-2">
        <button
          type="button"
          data-id="live_prev"
          className="btn btn-soft px-4 text-2xl"
          disabled={locked}
          onClick={() => prevPatch()}
        >
          ‹
        </button>
        <div className="flex-1 overflow-hidden rounded-[10px]">
          <div className="fondo-b1 py-2.5 text-center">
            <strong
              data-id="live_number"
              className="font-mono text-5xl tracking-widest tabular-nums"
            >
              {String(number).padStart(2, '0')}
            </strong>
          </div>
          <div
            data-id="live_name"
            className="fondo-b2 py-2.5 text-center font-mono text-2xl"
          >
            {name}
          </div>
        </div>
        <button
          type="button"
          data-id="live_next"
          className="btn btn-soft px-4 text-2xl"
          disabled={locked}
          onClick={() => nextPatch()}
        >
          ›
        </button>
      </div>

      <div className="grid min-h-[320px] flex-1 grid-cols-5 grid-rows-2 gap-3">
        {LIVE_ORDER.map((b) => {
          const block = BLOCKS[b];
          const on = enabled[b];
          return (
            <button
              key={b}
              type="button"
              data-id={`${block.key}_live`}
              className={`flex h-full items-center justify-center rounded-2xl border bg-ve-bg-2 p-2 transition disabled:opacity-40 ${
                on
                  ? 'border-ve-on opacity-100 shadow-[0_0_22px_rgba(61,220,151,0.4)]'
                  : 'border-ve-stroke opacity-40 hover:opacity-70'
              }`}
              disabled={locked}
              onClick={() => toggleBlock(block.key, !on)}
            >
              <img
                className="max-h-[86%] w-auto max-w-[90%] object-contain"
                src={iconSrc(block, selected[b])}
                alt={block.label}
                onError={(e) => {
                  const img = e.currentTarget;
                  img.onerror = null;
                  img.src = fallbackIcon(block.key);
                }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
};
