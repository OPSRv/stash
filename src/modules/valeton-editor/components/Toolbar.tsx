import { saveFile, savePatchToDevice, selectPatch } from '../lib/actions';
import { connectBluetooth } from '../lib/bluetooth';
import { connectMidi } from '../lib/midi';
import { disconnect, nextPatch, prevPatch } from '../lib/transport';
import { setState, useStore } from '../store/store';
import { Dropdown, DropdownItem } from './ui/Dropdown';
import {
  IconChevronLeft,
  IconChevronRight,
  IconDisconnect,
  IconDownload,
  IconGear,
  IconMagic,
  IconSave,
  IconSliders,
  IconTuningFork,
} from './ui/icons';
import { PedalSelect } from '../../../shared/ui/PedalSelect';
import {MasterBar} from "./MasterBar.tsx";
import { InlineTuner } from './InlineTuner';

interface ToolbarProps {
  onOpenPatch: () => void;
  onOpenSettings: () => void;
  onOpenTuner: () => void;
  onOpenPresetAi: () => void;
  /** Whether the inline live tuner is engaged (mic listening). */
  tunerLive: boolean;
  /** Toggle the inline live tuner on/off. */
  onToggleTuner: () => void;
}

// бренд-гліф: медіатор (guitar pick) — упізнаваний знак гітарного процесора.
// LED стану зʼєднання живе окремо як `.status-led` поверх плитки.
const BrandGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
    <path
      d="M16 5.5C20 5.5 26 7 26 13C26 18 20 26.5 16 26.5C12 26.5 6 18 6 13C6 7 12 5.5 16 5.5Z"
      fill="#f3f7fb"
    />
    {/* симетричний блик угорі для обʼєму */}
    <path
      d="M16 8C19 8 22.5 9 22.5 12.5"
      fill="none"
      stroke="#ffffff"
      strokeOpacity="0.7"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
);

export const Toolbar = ({
  onOpenPatch,
  onOpenSettings,
  onOpenTuner,
  onOpenPresetAi,
  tunerLive,
  onToggleTuner,
}: ToolbarProps) => {
  const connected = useStore((s) => s.connected);
  const connecting = useStore((s) => s.connecting);
  const transport = useStore((s) => s.transport);
  const deviceName = useStore((s) => s.deviceName);
  const locked = useStore((s) => s.locked);
  const saveEnabled = useStore((s) => s.saveEnabled);
  const liveView = useStore((s) => s.liveView);
  const patchNames = useStore((s) => s.patchNames);
  const currentPatchNumber = useStore((s) => s.currentPatchNumber);

  const deviceLabel = connected
    ? transport === 'ble'
      ? deviceName
      : 'GP-5 · USB'
    : connecting
      ? 'Connecting…'
      : 'Offline';

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {/* ── Бренд-плитка = кнопка конекту: офлайн → дропдаун USB/BLE,
             підключено / в процесі → статичний індикатор стану ── */}
      {!connected && !connecting ? (
        <Dropdown
          label={
            <>
              <BrandGlyph />
              <span className="status-led absolute -right-0.5 -bottom-0.5" />
            </>
          }
          buttonClass="brand-tile relative h-8 w-8 shrink-0 cursor-pointer transition hover:brightness-110"
          dataId="btn_connect"
          title="Connect GP-5 — choose Bluetooth or USB (MIDI). Use a Web Bluetooth + Web MIDI enabled browser."
        >
          {(close) => (
            <>
              <DropdownItem
                dataId="connect_usb"
                onClick={() => {
                  close();
                  connectMidi();
                }}
              >
                Connect via USB
              </DropdownItem>
              <DropdownItem
                dataId="connect_ble"
                onClick={() => {
                  close();
                  connectBluetooth();
                }}
              >
                Connect via Bluetooth
              </DropdownItem>
            </>
          )}
        </Dropdown>
      ) : (
        <span
          className="brand-tile relative h-8 w-8 shrink-0"
          title={deviceLabel}
        >
          <BrandGlyph />
          <span
            className={`status-led absolute -right-0.5 -bottom-0.5 ${connected ? 'on' : 'connecting'}`}
          />
        </span>
      )}

      {/* ── Індикатор спроби підключення ── */}
      {connecting && (
        <span
          className="text-meta font-medium text-ve-dim"
          data-id="connecting_label"
        >
          Connecting…
        </span>
      )}

      {/* ── Навігація по пресетах ── */}
      <div className="flex min-w-[140px] flex-1 items-stretch gap-1 sm:max-w-[320px]">
        <button
          data-id="btn_previous"
          className="btn btn-chrome px-2.5"
          disabled={locked}
          type="button"
          title="Previous patch"
          onClick={() => prevPatch()}
        >
          <IconChevronLeft />
        </button>
        <PedalSelect
          dataId="listPatches"
          className="min-w-0 flex-1"
          disabled={locked}
          value={currentPatchNumber}
          placeholder="—"
          options={patchNames.map((n, i) => ({
            value: i,
            label: `${String(i).padStart(2, '0')} · ${n}`,
          }))}
          onChange={(v) => selectPatch(v)}
        />
        <button
          data-id="btn_next"
          className="btn btn-chrome px-2.5"
          disabled={locked}
          type="button"
          title="Next patch"
          onClick={() => nextPatch()}
        >
          <IconChevronRight />
        </button>
        <Dropdown
          label={<IconDownload />}
          buttonClass="btn btn-chrome h-full px-2.5"
          disabled={locked}
          title="Save preset to file"
          align="right"
        >
          {(close) => (
            <>
              <DropdownItem
                dataId="saveGP5Preset"
                onClick={() => {
                  close();
                  saveFile('gp5');
                }}
              >
                Save GP-5 preset
              </DropdownItem>
              <DropdownItem
                dataId="saveGP50Preset"
                onClick={() => {
                  close();
                  saveFile('gp50');
                }}
              >
                Save GP-50 preset
              </DropdownItem>
            </>
          )}
        </Dropdown>
      </div>
      <MasterBar />
      {/* ── Дії (іконки + tooltip — підписи у тултипах, щоб не переносити рядок) ── */}
      <div className="ml-auto flex items-center gap-1.5">
        <div className="seg-group">
          <button
            type="button"
            data-id="btn_preset_ai"
            className="seg-btn px-2"
            title="AI preset generator"
            onClick={onOpenPresetAi}
          >
            <IconMagic />
          </button>
          <button
            type="button"
            data-id="btn_show_tuner"
            className={`seg-btn px-2 ${tunerLive ? 'active' : ''}`}
            aria-pressed={tunerLive}
            title={tunerLive ? 'Stop live tuner' : 'Live tuner'}
            onClick={onToggleTuner}
          >
            <IconTuningFork />
          </button>
          {tunerLive && <InlineTuner onExpand={onOpenTuner} />}
          <button
            type="button"
            data-id="btn_save_patch"
            className={`seg-btn px-2 ${saveEnabled ? 'accent' : ''}`}
            disabled={!saveEnabled}
            title="Save patch to device"
            onClick={() => savePatchToDevice()}
          >
            <IconSave />
          </button>
          <button
            type="button"
            data-id="btn_show_patch"
            className="seg-btn px-2"
            disabled={locked}
            title="Patch settings (CTL)"
            onClick={onOpenPatch}
          >
            <IconSliders />
          </button>
          <button
            type="button"
            data-id="btn_show_settings"
            className="seg-btn px-2"
            disabled={locked}
            title="Global device settings"
            onClick={onOpenSettings}
          >
            <IconGear />
          </button>
        </div>

        <div className="seg-group">
          <button
            type="button"
            data-id="live_switch"
            className={`seg-btn px-3 ${liveView ? 'active' : ''}`}
            disabled={locked}
            aria-pressed={liveView}
            title="Live performance view"
            onClick={() => setState({ liveView: !liveView })}
          >
            Live
          </button>
        </div>

        {connected && (
          <button
            type="button"
            data-id="btn_disconnect"
            className="btn btn-ghost px-2.5 text-ve-dim hover:text-ve-danger"
            title="Disconnect GP-5"
            disabled={locked}
            onClick={() => disconnect()}
          >
            <IconDisconnect />
          </button>
        )}
      </div>
    </div>
  );
};
