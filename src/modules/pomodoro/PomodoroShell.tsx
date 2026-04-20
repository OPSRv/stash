import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../shared/ui/Toast';
import {
  savePreset,
  startSession,
  type Block,
  type BlockChangedEvent,
  type Posture,
  type Preset,
} from './api';
import { PresetLibrary } from './PresetLibrary';
import { PresetEditor } from './PresetEditor';
import { SessionPlayer } from './SessionPlayer';
import { usePomodoroEngine } from './hooks/usePomodoroEngine';

type Mode =
  | { kind: 'library' }
  | { kind: 'editor'; draft: Preset | null }
  | { kind: 'session' };

type Banner = { from: Posture; to: Posture; block: string };

const libraryMode: Mode = { kind: 'library' };

export const PomodoroShell = () => {
  const [mode, setMode] = useState<Mode>(libraryMode);
  const [banner, setBanner] = useState<Banner | null>(null);
  const bannerTimer = useRef<number | null>(null);
  const { toast } = useToast();
  const reloadTrigger = useRef(0);

  const onTransition = useCallback((ev: BlockChangedEvent) => {
    setBanner({ from: ev.from_posture, to: ev.to_posture, block: ev.block_name });
    if (bannerTimer.current) window.clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => setBanner(null), 6000);
  }, []);

  const onNudge = useCallback(
    (ev: { text: string; block_name: string }) => {
      toast({
        title: ev.text,
        description: ev.block_name,
        variant: 'default',
        durationMs: 4000,
      });
    },
    [toast],
  );

  const { snapshot } = usePomodoroEngine({ onTransition, onNudge });

  useEffect(() => {
    if (snapshot.status === 'idle' && mode.kind === 'session') {
      setMode(libraryMode);
    }
    if (snapshot.status !== 'idle' && mode.kind !== 'session') {
      setMode({ kind: 'session' });
    }
  }, [snapshot.status, mode.kind]);

  useEffect(() => {
    return () => {
      if (bannerTimer.current) window.clearTimeout(bannerTimer.current);
    };
  }, []);

  const handleStartPreset = useCallback(
    async (p: Preset) => {
      try {
        await startSession(p.blocks, p.id);
      } catch (e) {
        console.error('start failed', e);
        toast({ title: 'Start failed', description: String(e), variant: 'error' });
      }
    },
    [toast],
  );

  const handleStartAdHoc = useCallback(
    async (blocks: Block[]) => {
      try {
        await startSession(blocks, null);
      } catch (e) {
        console.error('start ad-hoc failed', e);
        toast({ title: 'Start failed', description: String(e), variant: 'error' });
      }
    },
    [toast],
  );

  const handleSavePreset = useCallback(
    async (name: string, blocks: Block[]) => {
      try {
        await savePreset(name, blocks);
        toast({ title: 'Preset saved', variant: 'success' });
        reloadTrigger.current += 1;
        setMode(libraryMode);
      } catch (e) {
        console.error('save preset failed', e);
        toast({ title: 'Save failed', description: String(e), variant: 'error' });
      }
    },
    [toast],
  );

  if (mode.kind === 'session') {
    return (
      <SessionPlayer
        snapshot={snapshot}
        banner={banner}
        onDismissBanner={() => setBanner(null)}
      />
    );
  }

  if (mode.kind === 'editor') {
    return (
      <PresetEditor
        initial={mode.draft}
        onSave={handleSavePreset}
        onStartWithoutSaving={handleStartAdHoc}
        onCancel={() => setMode(libraryMode)}
      />
    );
  }

  return (
    <PresetLibrary
      key={reloadTrigger.current}
      onStart={handleStartPreset}
      onEdit={(p) => setMode({ kind: 'editor', draft: p })}
      onNew={() => setMode({ kind: 'editor', draft: null })}
    />
  );
};
