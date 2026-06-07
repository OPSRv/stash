import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MicIcon } from '../../shared/ui/icons';
import { Footswitch } from '../../shared/ui/pedal/Footswitch';
import { PedalEnclosure } from '../../shared/ui/pedal/PedalEnclosure';
import '../../shared/ui/pedal/pedal.css';
import './tuner.css';
import { tunerGetState, tunerSaveState } from './api';
import { DeviceSelect } from './components/DeviceSelect';
import { StringRow } from './components/StringRow';
import { TunerMeter } from './components/TunerMeter';
import { TuningSelect } from './components/TuningSelect';
import { useTuner } from './hooks/useTuner';
import { A4_HZ, DEFAULT_TUNING_ID, IN_TUNE_CENTS, tuningById, type Tuning } from './tuner.constants';

/** Payload for the `tuner:remote` event (assistant / CLI). */
type TunerRemote = {
  tuning_id?: string | null;
};

export const TunerShell = () => {
  const [tuning, setTuning] = useState<Tuning>(() => tuningById(DEFAULT_TUNING_ID));
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  const { listening, error, reading, devices, toggle, start } = useTuner(tuning, deviceId);

  // Hydrate the saved tuning + input device on first mount.
  useEffect(() => {
    tunerGetState()
      .then((s) => {
        setTuning(tuningById(s.tuning_id));
        setDeviceId(s.device_id ?? null);
      })
      .catch(() => {})
      .finally(() => {
        loadedRef.current = true;
      });
  }, []);

  // Persist the selected tuning + device (debounced) once hydrated.
  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      tunerSaveState({ tuning_id: tuning.id, device_id: deviceId }).catch(() => {});
    }, 200);
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, [tuning, deviceId]);

  // Engage the mic as soon as the tuner opens — a tuner that isn't listening
  // is just a diagram. `useTuner` releases the mic again on unmount.
  useEffect(() => {
    start();
  }, [start]);

  // Assistant / CLI can preset the tuning from natural language. The shell is
  // only mounted while the modal is open, so the Rust side also persists the
  // choice; this listener applies it live when the modal happens to be open.
  useEffect(() => {
    const unlisten = listen<TunerRemote>('tuner:remote', (e) => {
      const id = e.payload?.tuning_id;
      if (typeof id === 'string') setTuning(tuningById(id));
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const hasPitch = listening && reading.stringIndex >= 0;
  const inTune = hasPitch && Math.abs(reading.cents) <= IN_TUNE_CENTS;
  const noteLetter = reading.note?.replace(/\d+$/, '') ?? '–';
  const noteOctave = reading.note?.match(/\d+$/)?.[0] ?? '';
  const centsLabel = !hasPitch
    ? '––'
    : inTune
      ? 'IN TUNE'
      : `${reading.cents > 0 ? '+' : ''}${Math.round(reading.cents)}¢`;
  const flat = hasPitch && !inTune && reading.cents < 0;
  const sharp = hasPitch && !inTune && reading.cents > 0;

  return (
    <PedalEnclosure
      className="flex w-full flex-col gap-3 px-4 pb-4 pt-4"
      radius={16}
      playing={listening}
      boltAngles={[22, -18, -40, 14]}
    >
      {/* Engraved brand strip — the unit's identity, like a real pedal face. */}
      <div className="tuner-brand">
        <span className="tuner-brand-name">CHROMATIC TUNER</span>
        <span className="tuner-brand-model">ST-1 · A={A4_HZ}</span>
      </div>

      {/* Display window — big note + cents over the LED cents meter. */}
      <div className="pedal-window flex flex-col gap-1 px-4 pb-2 pt-3" data-playing={hasPitch}>
        <div className="flex items-center justify-between">
          {/* flat-side arrow lights when the note is flat */}
          <span className="tuner-dir" data-on={flat || undefined}>◀</span>
          <div className="flex items-baseline gap-2">
            <div className="tuner-note" data-tuned={inTune || undefined}>
              {noteLetter}
              <span className="tuner-note-oct">{noteOctave}</span>
            </div>
            <div
              className="tuner-cents tabular-nums"
              data-tuned={inTune || undefined}
              data-off={hasPitch && !inTune ? true : undefined}
            >
              {centsLabel}
            </div>
          </div>
          <span className="tuner-dir" data-on={sharp || undefined}>▶</span>
        </div>

        <TunerMeter cents={reading.cents} active={hasPitch} inTune={inTune} />

        <div className="pedal-readout text-meta flex items-center justify-center gap-2">
          {error ? (
            <span className="tuner-error">{error}</span>
          ) : (
            <>
              <span>{tuning.label}</span>
              <span className="pedal-readout-dim">·</span>
              <span className="tabular-nums">
                {hasPitch ? `${reading.freq.toFixed(1)} Hz` : listening ? 'Listening…' : 'Muted'}
              </span>
            </>
          )}
        </div>
      </div>

      {/* The selected tuning's strings — the matched one lights up. */}
      <StringRow tuning={tuning} activeIndex={reading.stringIndex} inTune={inTune} />

      {/* Tuning + input pickers, with the mic footswitch alongside. */}
      <div className="flex items-end gap-3 pt-1">
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="field-label">Tuning</span>
            <TuningSelect value={tuning} onChange={setTuning} />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="field-label">Input</span>
            <DeviceSelect value={deviceId} devices={devices} onChange={setDeviceId} />
          </label>
        </div>
        <Footswitch
          onClick={toggle}
          ariaLabel={listening ? 'Mute tuner microphone' : 'Engage tuner microphone'}
          caption={listening ? 'LIVE' : 'MUTED'}
          lit={listening}
          active={listening}
          testId="tuner-mic"
        >
          <MicIcon size={16} />
        </Footswitch>
      </div>
    </PedalEnclosure>
  );
};
