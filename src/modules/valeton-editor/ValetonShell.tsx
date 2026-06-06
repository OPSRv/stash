import { useEffect, useRef, useState } from 'react';
import { onDeviceDisconnected, onRx } from './api';
import { EffectCard } from './components/EffectCard';
import { LiveView } from './components/LiveView';
import { HelpModal } from './components/modals/HelpModal';
import { LoadModal } from './components/modals/LoadModal';
import { PatchModal } from './components/modals/PatchModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { SignalChain } from './components/SignalChain';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { ScrollArea } from './components/ui/ScrollArea';
import { tapTempo, toggleBlock } from './lib/actions';
import { BLOCK_BY_KEY } from './lib/blocks';
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
  const [showHelp, setShowHelp] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);

  // Підписка на вхідні байти від Rust-моста + раптове від'єднання пристрою.
  useEffect(() => {
    const unRx = onRx(({ transport, bytes }) => {
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

  // клавіатурні шорткати — лише коли вкладка редактора видима (оболонка
  // лишається змонтованою на інших вкладках, тож слухач на document інакше
  // ловив би натискання глобально).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      const tag = (document.activeElement?.tagName ?? '').toUpperCase();
      const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(tag);

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
        />
      </header>

      <main className="scroll-area min-h-0 flex-1 space-y-4 py-4 lg:grid lg:grid-cols-12 lg:gap-4 lg:space-y-0 lg:overflow-hidden">
        <section
          className={`min-h-0 ${liveView ? 'lg:col-span-12' : 'lg:col-span-8'}`}
        >
          <ScrollArea className="pr-1 lg:h-full">
            {liveView ? <LiveView /> : <SignalChain />}
          </ScrollArea>
        </section>
        {!liveView && (
          <aside className="min-h-0 lg:col-span-4 ">
            <ScrollArea className="pr-1 lg:h-full">
              <EffectCard key={card.key} block={card} />
            </ScrollArea>
          </aside>
        )}
      </main>

      <footer className="panel-bar relative -mx-3 shrink-0 border-t border-ve-stroke backdrop-blur">
        <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-ve-accent/45 to-transparent" />
        <StatusBar onOpenHelp={() => setShowHelp(true)} />
      </footer>

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
      />
      <PatchModal open={showPatch} onClose={() => setShowPatch(false)} />
      <HelpModal open={showHelp} onClose={() => setShowHelp(false)} />
      <LoadModal />
    </div>
  );
};
