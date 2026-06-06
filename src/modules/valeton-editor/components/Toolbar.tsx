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
  IconSave,
  IconSliders,
} from './ui/icons';
import { Select } from './ui/Select';
import {MasterBar} from "./MasterBar.tsx";

interface ToolbarProps {
  onOpenPatch: () => void;
  onOpenSettings: () => void;
}

// логотип-пляшка: ручка + зелений LED на синій плитці бренду
const BrandGlyph = () => (
  <svg width="19" height="19" viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="8" fill="#0b0d10" />
    <rect x="15" y="8.5" width="2" height="7" rx="1" fill="#e6eaf0" />
    <circle cx="25" cy="7" r="2.6" fill="#3ddc97" />
  </svg>
);

export const Toolbar = ({ onOpenPatch, onOpenSettings }: ToolbarProps) => {
  const connected = useStore((s) => s.connected);
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
    : 'Offline';

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {/* ── Бренд-плитка + LED стану (повна назва — у футері StatusBar) ── */}
      <span
        className="brand-tile relative h-8 w-8 shrink-0"
        title={deviceLabel}
      >
        <BrandGlyph />
        <span
          className={`status-led absolute -right-0.5 -bottom-0.5 ${connected ? 'on' : ''}`}
        />
      </span>

      {/* ── Підключення (лише коли офлайн) ── */}
      {!connected && (
        <Dropdown
          label="Connect GP-5"
          buttonClass="btn btn-primary"
          dataId="btn_connect"
          title="Choose Bluetooth or USB (MIDI). Use Chrome / a Web Bluetooth + Web MIDI enabled browser."
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
      )}

      {/* ── Навігація по пресетах ── */}
      <div className="flex min-w-[140px] flex-1 items-stretch gap-1 sm:max-w-[320px]">
        <button
          data-id="btn_previous"
          className="btn btn-ghost px-2.5"
          disabled={locked}
          type="button"
          title="Previous patch"
          onClick={() => prevPatch()}
        >
          <IconChevronLeft />
        </button>
        <Select
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
          className="btn btn-ghost px-2.5"
          disabled={locked}
          type="button"
          title="Next patch"
          onClick={() => nextPatch()}
        >
          <IconChevronRight />
        </button>
        <Dropdown
          label={<IconDownload />}
          buttonClass="btn btn-ghost px-2.5"
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
            title="Patch settings (CTL, patch volume)"
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

        <label
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-ve-stroke bg-ve-bg-1 px-2.5 py-1.5 whitespace-nowrap"
          title="Live performance view"
        >
          <input
            className="switch switch-ve-accent"
            type="checkbox"
            data-id="live_switch"
            disabled={locked}
            checked={liveView}
            onChange={(e) => setState({ liveView: e.target.checked })}
          />
          <span className="text-sm font-medium text-ve-text">Live</span>
        </label>

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
