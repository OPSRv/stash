import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { RangeSlider } from '../../shared/ui/RangeSlider';
import { Spinner } from '../../shared/ui/Spinner';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { useToast } from '../../shared/ui/Toast';
import {
  listHardwareDisplays,
  powerOffDisplay,
  powerOnDisplay,
  setDisplayBrightness,
  sleepDisplays,
  type DisplayDevice,
} from './api';

const MoonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);
const SunIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);
const PowerIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18.36 6.64a9 9 0 1 1-12.72 0M12 2v10" />
  </svg>
);

type BrightnessSliderProps = {
  value: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
  disabled?: boolean;
  note?: string;
};

const BrightnessSlider = ({ value, onChange, onCommit, disabled, note }: BrightnessSliderProps) => {
  const pct = Math.round(value * 100);
  return (
    <div>
      <div className="flex items-center gap-2">
        <SunIcon />
        {/* Wrap in a div so pointer-up / key-up bubble up for commit */}
        <div
          className="flex-1"
          onPointerUp={(e) => {
            const input = e.currentTarget.querySelector('input');
            if (input) onCommit(Number(input.value) / 100);
          }}
          onKeyUp={(e) => {
            const input = e.currentTarget.querySelector('input');
            if (input) onCommit(Number(input.value) / 100);
          }}
        >
          <RangeSlider
            value={pct}
            min={0}
            max={100}
            step={1}
            label="Brightness"
            disabled={disabled}
            onChange={(v) => onChange(v / 100)}
            className="w-full"
          />
        </div>
        <span className="t-primary text-body tabular-nums font-medium w-[38px] text-right">
          {pct}%
        </span>
      </div>
      {note && <div className="t-tertiary text-meta mt-1">{note}</div>}
    </div>
  );
};

const DisplayCard = ({
  d,
  alone,
  powering,
  onChangeBrightness,
  onCommitBrightness,
  onPowerOff,
  onPowerOn,
}: {
  d: DisplayDevice;
  alone: boolean;
  powering: boolean;
  onChangeBrightness: (id: number, v: number) => void;
  onCommitBrightness: (id: number, v: number) => void;
  onPowerOff: (d: DisplayDevice) => void;
  onPowerOn: (d: DisplayDevice) => void;
}) => {
  const off = d.mirrors !== 0;
  // Brightness slider is always interactive when the display is on: for
  // built-in / Studio Display we drive DisplayServices; for everything else
  // we fall back to DDC/CI. The backend picks the right channel, so the UI
  // never needs to grey the slider out based on capability reporting — which
  // lies on many USB-C docks anyway.
  const brightness = d.brightness ?? 0.7;
  const sliderDisabled = off;
  const note = !d.supports_brightness && !off
    ? 'Panel does not respond to DisplayServices or DDC — change may have no effect.'
    : undefined;

  // NB: `overflow-hidden` is *not* on the outer card any more — if it were,
  // any dropdown/popup (e.g. the resolution Select below) would get clipped
  // and render underneath the card. Instead we move the clip onto a
  // dedicated child that only wraps the decorative glow, so visual effects
  // stay bounded while popovers escape freely.
  return (
    <div
      className="relative rounded-2xl p-3"
      style={{
        background: off
          ? 'linear-gradient(135deg, rgba(120,120,120,0.10), rgba(70,70,70,0.14))'
          : 'linear-gradient(135deg, rgba(94,226,196,0.10), rgba(85,97,255,0.18))',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
      }}
    >
      <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none">
        <div
          aria-hidden
          className="absolute -top-10 -right-6 w-36 h-36 rounded-full"
          style={{
            background: off
              ? 'radial-gradient(closest-side, rgba(120,120,120,0.35), transparent)'
              : 'radial-gradient(closest-side, rgba(142,197,255,0.45), transparent)',
            filter: 'blur(8px)',
          }}
        />
      </div>
      <div className="relative flex items-center gap-3 mb-2">
        <div
          aria-hidden
          className="shrink-0 w-14 h-10 rounded-md relative"
          style={{
            background: off
              ? 'linear-gradient(135deg,#1a1a1a,#0c0c0c)'
              : 'linear-gradient(135deg,#2a3050,#1a2038)',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12), 0 2px 6px rgba(0,0,0,0.25)',
            opacity: off ? 0.35 : 1,
          }}
        >
          <div className="absolute left-1/2 -translate-x-1/2 -bottom-1 w-5 h-1 rounded-b bg-black/40" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <div className="t-primary text-body font-semibold truncate">{d.name}</div>
            {d.is_main && (
              <span className="text-[10px] px-1 py-px rounded bg-white/10 t-secondary">
                main
              </span>
            )}
            {d.is_builtin && (
              <span className="text-[10px] px-1 py-px rounded bg-white/10 t-secondary">
                built-in
              </span>
            )}
            {off && (
              <span
                className="text-[10px] px-1 py-px rounded t-secondary"
                style={{ background: 'rgba(255,58,111,0.18)', color: '#ff8080' }}
              >
                off
              </span>
            )}
          </div>
          <div className="t-tertiary text-meta">
            {d.is_builtin ? 'Built-in' : 'External'} · ID {d.id}
          </div>
        </div>
        {off ? (
          <Button
            size="sm"
            variant="solid"
            tone="success"
            leadingIcon={<PowerIcon />}
            onClick={() => onPowerOn(d)}
            loading={powering}
          >
            Turn on
          </Button>
        ) : (
          <Button
            size="sm"
            variant="soft"
            tone="danger"
            leadingIcon={<PowerIcon />}
            onClick={() => onPowerOff(d)}
            loading={powering}
            disabled={alone}
            title={
              alone
                ? 'At least one other display is needed as a mirror target'
                : d.is_main
                ? 'Turn off main display (another will become main)'
                : 'Turn off this display'
            }
          >
            Turn off
          </Button>
        )}
      </div>

      <BrightnessSlider
        value={brightness}
        onChange={(v) => onChangeBrightness(d.id, v)}
        onCommit={(v) => onCommitBrightness(d.id, v)}
        disabled={sliderDisabled}
        note={note}
      />
    </div>
  );
};

export const DisplaysPanel = () => {
  const [displays, setDisplays] = useState<DisplayDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [pendingOff, setPendingOff] = useState<DisplayDevice | null>(null);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      setDisplays(await listHardwareDisplays());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    // Re-poll every 3 s so external changes (e.g. user plugs monitor,
    // System Settings changes layout) are reflected without a manual refresh.
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const masterId = useMemo(() => {
    if (!displays) return null;
    const main = displays.find((d) => d.is_main && d.mirrors === 0);
    return main?.id ?? displays.find((d) => d.mirrors === 0)?.id ?? null;
  }, [displays]);

  const handleChangeBrightness = useCallback((id: number, v: number) => {
    setDisplays((prev) =>
      prev ? prev.map((d) => (d.id === id ? { ...d, brightness: v } : d)) : prev,
    );
  }, []);

  const handleCommitBrightness = useCallback(
    async (id: number, v: number) => {
      try {
        await setDisplayBrightness(id, v);
      } catch (e) {
        toast({
          title: 'Failed to change brightness',
          description: String(e),
          variant: 'error',
        });
        refresh();
      }
    },
    [toast, refresh],
  );

  const handlePowerOn = useCallback(
    async (d: DisplayDevice) => {
      setBusyId(d.id);
      try {
        await powerOnDisplay(d.id);
        toast({ title: 'Display turned on', variant: 'success' });
        await refresh();
      } catch (e) {
        toast({ title: 'Failed to turn on', description: String(e), variant: 'error' });
      } finally {
        setBusyId(null);
      }
    },
    [refresh, toast],
  );

  const confirmPowerOff = useCallback(async () => {
    if (!pendingOff || masterId === null) {
      setPendingOff(null);
      return;
    }
    const target = pendingOff;
    setPendingOff(null);
    setBusyId(target.id);
    try {
      await powerOffDisplay(target.id, masterId);
      toast({
        title: 'Display turned off',
        description: 'Use the Turn on button next to this display to re-enable it',
        variant: 'success',
      });
      await refresh();
    } catch (e) {
      toast({ title: 'Failed to turn off', description: String(e), variant: 'error' });
    } finally {
      setBusyId(null);
    }
  }, [pendingOff, masterId, refresh, toast]);

  const handleSleepAll = useCallback(async () => {
    try {
      await sleepDisplays();
      toast({ title: 'Displays sleeping', variant: 'success' });
    } catch (e) {
      toast({ title: 'Failed', description: String(e), variant: 'error' });
    }
  }, [toast]);

  return (
    <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="t-primary text-title font-semibold">Displays</div>
          <div className="t-tertiary text-meta">
            Brightness via DisplayServices or DDC/CI · Turn off / Turn on
            any display (turning off the main one makes another the main automatically).
          </div>
        </div>
        <Button
          variant="solid"
          tone="neutral"
          size="sm"
          leadingIcon={<MoonIcon />}
          onClick={handleSleepAll}
        >
          Sleep all
        </Button>
      </header>

      {error && <div className="t-danger text-body">Error: {error}</div>}
      {!error && !displays && (
        <div className="flex items-center justify-center py-6">
          <Spinner />
        </div>
      )}
      {!error && displays && displays.length === 0 && (
        <div className="t-tertiary text-body">No displays found.</div>
      )}
      {!error && displays && displays.length > 0 && (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}
        >
          {displays.map((d) => (
            <DisplayCard
              key={d.id}
              d={d}
              alone={displays.length < 2}
              powering={busyId === d.id}
              onChangeBrightness={handleChangeBrightness}
              onCommitBrightness={handleCommitBrightness}
              onPowerOff={setPendingOff}
              onPowerOn={handlePowerOn}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingOff !== null}
        title="Turn off this display?"
        description={
          pendingOff
            ? `${pendingOff.name}${pendingOff.is_main ? ' (main — another display will become main first)' : ''} will be programmatically turned off: brightness drops to 0, the external monitor enters DPMS sleep, and macOS stops sending windows there. Current brightness is saved and restored when turned back on.`
            : undefined
        }
        confirmLabel="Turn off"
        tone="danger"
        onConfirm={confirmPowerOff}
        onCancel={() => setPendingOff(null)}
      />
    </div>
  );
};
