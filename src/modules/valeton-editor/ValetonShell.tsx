import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
// Cross-module import (deliberate trade-off): the Metronome no longer has its
// own tab — it is hosted here, inside the Valeton editor. The module still
// lives under `src/modules/metronome/` and keeps its own Rust state + agent
// surface; we only borrow its shell for rendering. See CLAUDE.md "Modularity".
import { MetronomeShell } from '../metronome/MetronomeShell';
// Cross-module import (deliberate trade-off): same arrangement as the
// Metronome above — the Recorder is its own module (own SQLite store, audio
// dir, agent surface under `src/modules/recorder/`) but has no tab; we host
// its shell here in the tools bay. See CLAUDE.md "Modularity".
import { RecorderShell } from '../recorder/RecorderShell';
import { onDeviceDisconnected, onRx } from './api';
import { EffectCard } from './components/EffectCard';
import { LiveView } from './components/LiveView';
import { LoadModal } from './components/modals/LoadModal';
import { PatchModal } from './components/modals/PatchModal';
import { PresetAiModal } from './components/modals/PresetAiModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { TunerModal } from './components/modals/TunerModal';
import { SignalChain } from './components/SignalChain';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { ScrollArea } from './components/ui/ScrollArea';
import { tapTempo, toggleBlock } from './lib/actions';
import { BLOCK_BY_KEY } from './lib/blocks';
import { confirmHandshake } from './lib/connection';
import { onDisconnected } from './lib/bluetooth';
import { connectMidi, disconnectMidi, handleMIDIMessage } from './lib/midi';
import { handleNotification } from './lib/bluetooth';
import { runtime } from './lib/runtime';
import { nextPatch, prevPatch } from './lib/transport';
import { getState, useStore } from './store/store';
import type { BlockKey } from './store/types';
import './valeton.css';

// клавіша (code) → блок ефекту (цифри + QWERTYUIOP, як у vanilla)
const KEY_TO_BLOCK: Record<string, BlockKey> = {
  Digit1: 'nr',
  KeyQ: 'nr',
  Digit2: 'pre',
  KeyW: 'pre',
  Digit3: 'dst',
  KeyE: 'dst',
  Digit4: 'ns',
  KeyR: 'ns',
  Digit5: 'amp',
  KeyT: 'amp',
  Digit6: 'cab',
  KeyY: 'cab',
  Digit7: 'eq',
  KeyU: 'eq',
  Digit8: 'mod',
  KeyI: 'mod',
  Digit9: 'dly',
  KeyO: 'dly',
  Digit0: 'rvb',
  KeyP: 'rvb',
};

export const ValetonShell = () => {
  const liveView = useStore((s) => s.liveView);
  const openCard = useStore((s) => s.openCard);

  const [showSettings, setShowSettings] = useState(false);
  const [showPatch, setShowPatch] = useState(false);
  const [showTuner, setShowTuner] = useState(false);
  const [showPresetAi, setShowPresetAi] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);

  // Підписка на вхідні байти від Rust-моста + раптове від'єднання пристрою.
  useEffect(() => {
    const unRx = onRx(({ transport, bytes }) => {
      confirmHandshake(); // перша відповідь пристрою підтверджує живе підключення
      if (transport === 'usb') handleMIDIMessage(bytes);
      else handleNotification(bytes);
    });
    const unDc = onDeviceDisconnected(() => {
      if (getState().transport === 'usb') disconnectMidi();
      else onDisconnected();
    });
    return () => {
      unRx.then((f) => f());
      unDc.then((f) => f());
    };
  }, []);

  // авто-спроба USB-підключення при першому відкритті вкладки
  useEffect(() => {
    connectMidi();
  }, []);

  // Асистент / CLI може відкрити тюнер (і задати стрій) через `tuner:remote`.
  // Сам стрій застосовує TunerShell усередині модалки; тут лише відкриваємо її.
  useEffect(() => {
    const un = listen('tuner:remote', () => setShowTuner(true));
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  // клавіатурні шорткати — лише коли вкладка редактора видима (оболонка
  // лишається змонтованою на інших вкладках, тож слухач на document інакше
  // ловив би натискання глобально).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      const tag = (document.activeElement?.tagName ?? '').toUpperCase();
      const inField =
        /^(INPUT|SELECT|TEXTAREA)$/.test(tag) ||
        (document.activeElement as HTMLElement | null)?.isContentEditable ===
          true;

      // Поки фокус у текстовому полі (напр. модалка AI-пресета) — жодних
      // шорткатів редактора: інакше літери перемикають блоки, а Space
      // тригерить tap-tempo прямо під час набору.
      if (inField) return;

      const block = KEY_TO_BLOCK[e.code];
      if (block) {
        e.preventDefault();
        const s = getState();
        if (!s.locked)
          toggleBlock(block, !s.enabled[BLOCK_BY_KEY[block].index]);
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        tapTempo();
      } else if (e.code === 'PageDown') {
        e.preventDefault();
        nextPatch();
      } else if (e.code === 'PageUp') {
        e.preventDefault();
        prevPatch();
      } else if (e.code === 'ArrowLeft' && !inField) {
        e.preventDefault();
        prevPatch();
      } else if (e.code === 'ArrowRight' && !inField) {
        e.preventDefault();
        nextPatch();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // скидання tap-буфера (порт setInterval 500мс)
  useEffect(() => {
    const id = setInterval(() => {
      if (
        runtime.taps.length &&
        Date.now() - runtime.taps[runtime.taps.length - 1] > 3000
      ) {
        runtime.taps = [];
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  const card = BLOCK_BY_KEY[openCard];

  return (
    <div
      ref={rootRef}
      className="valeton-root flex h-full flex-col overflow-hidden px-3"
    >
      <header className="panel-bar relative -mx-3 shrink-0 border-b border-ve-stroke px-4 py-2.5">
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-ve-accent/45 to-transparent" />
        <Toolbar
          onOpenPatch={() => setShowPatch(true)}
          onOpenSettings={() => setShowSettings(true)}
          onOpenTuner={() => setShowTuner(true)}
          onOpenPresetAi={() => setShowPresetAi(true)}
        />
      </header>

      <main className="scroll-area min-h-0 flex-1 space-y-4 py-4 lg:grid lg:grid-cols-12 lg:gap-4 lg:space-y-0 lg:overflow-hidden">
        <section
          className={`flex min-h-0 flex-col gap-4 ${liveView ? 'lg:col-span-12' : 'lg:col-span-8'}`}
        >
          {liveView ? (
            <ScrollArea className="pr-1 lg:h-full">
              <LiveView />
            </ScrollArea>
          ) : (
            <>
              {/* No ScrollArea here — the chain is a fixed 2×5 grid that never
                  scrolls; wrapping it only reserved an asymmetric right gutter
                  (scrollbar-gutter + pr-1) that pushed the cards out of line
                  with the tools bay below. */}
              <div className="shrink-0">
                <SignalChain />
              </div>
              {/* Tools bay — metronome on the left, recorder slot on the
                  right. Two equal halves so a record module can drop in
                  beside the metronome. */}
              <div className="flex min-h-[220px] flex-1 gap-4">
                {/* No wrapper frame here — the PedalEnclosure is already a
                    self-contained framed surface (metal body, rounded corners,
                    shadow). A border/bg/scroll wrapper would double-frame it and
                    reserve a scrollbar gutter on the right. */}
                <section aria-label="Metronome" className="flex min-w-0 flex-1 basis-0">
                  <MetronomeShell embedded />
                </section>
                <section
                  aria-label="Recorder"
                  className="flex-1 basis-0 overflow-hidden rounded-[10px] border border-ve-stroke bg-ve-bg-1"
                >
                  <RecorderShell embedded />
                </section>
              </div>
            </>
          )}
        </section>
        {!liveView && (
          <aside className="min-h-0 lg:col-span-4">
            <div className="lg:h-full lg:overflow-hidden">
              <EffectCard key={card.key} block={card} />
            </div>
          </aside>
        )}
      </main>

      <footer className="panel-bar relative -mx-3 shrink-0 border-t border-ve-stroke backdrop-blur">
        <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-ve-accent/45 to-transparent" />
        <StatusBar />
      </footer>

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
      />
      <PatchModal open={showPatch} onClose={() => setShowPatch(false)} />
      <PresetAiModal
        open={showPresetAi}
        onClose={() => setShowPresetAi(false)}
      />
      <TunerModal open={showTuner} onClose={() => setShowTuner(false)} />
      <LoadModal />
    </div>
  );
};
