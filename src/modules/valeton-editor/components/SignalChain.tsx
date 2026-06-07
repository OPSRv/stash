import { useState } from 'react';
import { reorderEffects, toggleBlock } from '../lib/actions';
import { BLOCKS, fallbackIcon, iconSrc } from '../lib/blocks';
import { setState, useStore } from '../store/store';

type DropPos = 'before' | 'after' | null;

/** Сигнальний ланцюг: сітка 2×5 педалей із drag&drop порядку.
   Клік — відкрити картку блока; подвійний клік — увімк/вимк блок. */
export const SignalChain = () => {
  const order = useStore((s) => s.order);
  const enabled = useStore((s) => s.enabled);
  const selected = useStore((s) => s.selected);
  const locked = useStore((s) => s.locked);
  const openCard = useStore((s) => s.openCard);
  const nsOn = useStore((s) => s.enabled[9]);

  const [dragged, setDragged] = useState<number | null>(null);
  const [dropOn, setDropOn] = useState<{ block: number; pos: DropPos } | null>(
    null,
  );

  const clearDrag = () => {
    setDragged(null);
    setDropOn(null);
  };

  const onDrop = (target: number) => {
    if (
      dragged === null ||
      dragged === target ||
      !dropOn ||
      dropOn.block !== target ||
      !dropOn.pos
    ) {
      clearDrag();
      return;
    }
    const next = order.filter((b) => b !== dragged);
    const ti = next.indexOf(target);
    next.splice(dropOn.pos === 'before' ? ti : ti + 1, 0, dragged);
    reorderEffects(next);
    clearDrag();
  };

  return (
    <div id="btn_list" className="grid grid-cols-5 gap-3 -mx-1.5 px-1.5 py-1.5">
      {order.map((b) => {
        const block = BLOCKS[b];
        const on = enabled[b];
        const danger = (block.key === 'amp' || block.key === 'cab') && nsOn;
        const isOpen = openCard === block.key;

        const base =
          've-pedal relative flex min-h-[180px] cursor-pointer items-center justify-center overflow-hidden rounded-[10px] p-1.5 transition disabled:cursor-default disabled:opacity-40';
        // Active blocks are shown by a brighter coloured border + soft glow and
        // the corner LED — no top bar (it read as an unwanted lip on the glass).
        const tone = danger
          ? '!border-ve-danger/60 !bg-ve-danger/12 shadow-[0_0_18px_rgba(255,92,92,0.18)]'
          : on
            ? '!border-ve-on/55 text-ve-text shadow-[0_0_18px_rgba(61,220,151,0.18)]'
            : 'text-ve-faint';
        const ring = isOpen ? 'ring-2 ring-ve-accent' : '';
        const dropRing =
          dropOn?.block === b && dropOn.pos === 'before'
            ? 'shadow-[-4px_0_0_0_var(--color-ve-on)]'
            : dropOn?.block === b && dropOn.pos === 'after'
              ? 'shadow-[4px_0_0_0_var(--color-ve-on)]'
              : '';

        return (
          <div
            key={b}
            data-id={`order_${b}`}
            className={`${block.draggable ? 'cursor-grab' : ''} ${dragged === b ? 'opacity-50' : ''}`}
            draggable={block.draggable && !locked}
            onDragStart={() => block.draggable && setDragged(b)}
            onDragEnd={clearDrag}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragged === null || dragged === b) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const before = e.clientX - rect.left < rect.width / 2;
              if (before && block.dropBefore)
                setDropOn({ block: b, pos: 'before' });
              else if (!before && block.dropAfter)
                setDropOn({ block: b, pos: 'after' });
              else setDropOn({ block: b, pos: null });
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDrop(b);
            }}
          >
            <button
              type="button"
              data-id={`${block.key}_button`}
              className={`${base} ${tone} ${ring} ${dropRing} w-full`}
              disabled={locked}
              onClick={() => setState({ openCard: block.key })}
              onDoubleClick={() => !locked && toggleBlock(block.key, !on)}
            >
              {isOpen && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-[9px]"
                  style={{
                    background: 'rgba(var(--stash-accent-rgb), 0.12)',
                    boxShadow:
                      'inset 0 0 0 1px rgba(var(--stash-accent-rgb), 0.55)',
                  }}
                />
              )}
              <span
                className={`led${on ? ' on' : ''}${danger ? ' danger' : ''}`}
              />
              <img
                className={`h-[150px] w-auto max-w-full rounded-md transition-opacity ${
                  on || danger ? 'opacity-100' : 'opacity-45'
                }`}
                src={iconSrc(block, selected[b])}
                alt={block.label}
                onError={(e) => {
                  const img = e.currentTarget;
                  img.onerror = null;
                  img.src = fallbackIcon(block.key);
                }}
              />
            </button>
          </div>
        );
      })}
    </div>
  );
};
