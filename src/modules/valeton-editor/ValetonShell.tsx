import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
// Cross-module import (deliberate trade-off): the Metronome no longer has its
// own tab — it is hosted here, inside the Valeton editor. The module still
// lives under `src/modules/metronome/` and keeps its own Rust state + agent
// surface; we only borrow its shell for rendering. See CLAUDE.md "Modularity".
import { MetronomeShell } from '../metronome/MetronomeShell';
// Cross-module import (deliberate trade-off): same hosting arrangement as the
// Metronome/Recorder — the circle of fifths is its own module under
// `src/modules/circle-of-fifths/` (own store, theory libs, Rust command) but
// has no tab; the `Circle` toolbar button shows it here. Lazy so the whole
// module stays off-heap until first opened. See CLAUDE.md "Modularity".
const CircleShell = lazy(() =>
  import('../circle-of-fifths').then((m) => ({ default: m.CircleShell })),
);
// Cross-module import (deliberate trade-off): same arrangement as the
// Metronome above — the Recorder is its own module (own SQLite store, audio
// dir, agent surface under `src/modules/recorder/`) but has no tab; we host
// its shell here in the tools bay. See CLAUDE.md "Modularity".
import { RecorderShell } from '../recorder/RecorderShell';
import { onDeviceDisconnected, onRx, usbPresent } from './api';
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
import { CenterSpinner } from '../../shared/ui/CenterSpinner';
import { ScrollArea } from './components/ui/ScrollArea';
import { tapTempo, toggleBlock } from './lib/actions';
import { BLOCK_BY_KEY } from './lib/blocks';
import { confirmHandshake } from './lib/connection';
import { onDisconnected } from './lib/bluetooth';
import { connectMidi, disconnectMidi, handleMIDIMessage } from './lib/midi';
import { handleNotification } from './lib/bluetooth';
import { applyValetonRemote, type ValetonRemote } from './lib/remote';
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
  const circleView = useStore((s) => s.circleView);
  const openCard = useStore((s) => s.openCard);

  const [showSettings, setShowSettings] = useState(false);
  const [showPatch, setShowPatch] = useState(false);
  const [showTuner, setShowTuner] = useState(false);
  const [tunerLive, setTunerLive] = useState(false);
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

  // Авто-підключення по USB: тихо опитуємо наявність порту GP-5 і конектимось,
  // щойно процесор з'являється — не лише при першому відкритті вкладки, а й коли
  // його вмикають уже після запуску програми. Поки пристрою немає, нічого не
  // логуємо (інакше «No GP-5 detected» спамив би щотіку). Поки підключені /
  // в процесі / на іншому транспорті (BLE) — не втручаємось.
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      // Вкладка прихована (шел лишається змонтованим на інших вкладках) —
      // не ганяємо CoreMIDI-пробу даремно.
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      const s = getState();
      if (s.connected || s.connecting || s.transport) return;
      if ((await usbPresent()) && !stopped) {
        const cur = getState();
        if (!cur.connected && !cur.connecting && !cur.transport) connectMidi();
      }
    };
    void tick(); // негайна спроба при відкритті (миттєвий конект, якщо вже ввімкнено)
    const id = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  // Асистент / CLI може відкрити тюнер (і задати стрій) через `tuner:remote`.
  // Сам стрій застосовує TunerShell усередині модалки; тут лише відкриваємо її.
  useEffect(() => {
    const un = listen('tuner:remote', () => setShowTuner(true));
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  // Асистент / CLI може керувати редактором (вибір патча, темп, перемикання
  // блоків, AI-тон, збереження) через `valeton:remote`. Дії виконуються тими
  // ж хелперами з actions.ts, що й ручне редагування.
  useEffect(() => {
    const un = listen<ValetonRemote>('valeton:remote', (e) => {
      void applyValetonRemote(e.payload);
    });
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

      // No editor shortcuts while the Circle view is up: arrows walk the
      // circle of fifths there (CircleShell's own listener), and letters /
      // Space would surprise-toggle blocks or tap the tempo.
      if (getState().circleView) return;

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
      {/* z-30: lifts the header (and the connect dropdown anchored in it) above
          <main>, whose pedal cards carry `backdrop-filter` and so paint their
          own stacking contexts that would otherwise swallow the absolute menu.
          Stays below modals (z-50). */}
      <header className="panel-bar relative z-30 -mx-3 shrink-0 border-b border-white/10 px-4 py-1.5">
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-ve-accent/45 to-transparent" />
        <Toolbar
          onOpenPatch={() => setShowPatch(true)}
          onOpenSettings={() => setShowSettings(true)}
          onOpenTuner={() => setShowTuner(true)}
          onOpenPresetAi={() => setShowPresetAi(true)}
          tunerLive={tunerLive}
          onToggleTuner={() => setTunerLive((v) => !v)}
        />
      </header>

      <main className="scroll-area min-h-0 flex-1 space-y-4 py-4 lg:grid lg:grid-cols-12 lg:gap-4 lg:space-y-0 lg:overflow-hidden">
        <section
          className={`flex min-h-0 flex-col gap-4 ${liveView || circleView ? 'lg:col-span-12' : 'lg:col-span-8'}`}
        >
          {liveView ? (
            <ScrollArea className="pr-1 lg:h-full">
              <LiveView />
            </ScrollArea>
          ) : circleView ? (
            <Suspense fallback={<CenterSpinner />}>
              <CircleShell />
            </Suspense>
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
                  className="ve-panel flex-1 basis-0 overflow-hidden rounded-[10px]"
                >
                  <RecorderShell embedded />
                </section>
              </div>
            </>
          )}
        </section>
        {!liveView && !circleView && (
          <aside className="min-h-0 lg:col-span-4">
            <div className="lg:h-full lg:overflow-hidden">
              <EffectCard key={card.key} block={card} />
            </div>
          </aside>
        )}
      </main>

      <footer className="panel-bar relative -mx-3 shrink-0 border-t border-white/10">
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
