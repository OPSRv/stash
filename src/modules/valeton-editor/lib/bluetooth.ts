/* BLE-драйвер (GATT через Rust-міст). Транспортно-специфічне: connect/
   disconnect, сире надсилання у характеристику, розбір вхідних нотифікацій
   (зміщення bytes[5]/[6], корисні дані .slice(11)). Спільне — у protocol.ts /
   sync.ts. Сире байтове I/O делегується Rust (api.ts), бо WKWebView не має
   Web Bluetooth. */
import { connectBle, disconnectDevice, sendBytes } from '../api';
import { awaitHandshake, cancelHandshake } from './connection';
import { getState, log, setState } from '../store/store';
import { sendParamChange, sendPatchSelect } from './protocol';
import { runtime } from './runtime';
import { applyPatch, buildPatchList } from './sync';
import { setActiveTransport, type TransportDriver } from './transport';
import { getName, hexStringToBytes, hexToSignedInt } from './utils';

/* сире надсилання повністю сформованого sysex у характеристику (через Rust) */
function sendSysex(sysex: string): void {
  const hex = sysex.trim().replace(/[^0-9a-fA-F]/g, '');
  if (hex.length % 2 !== 0) {
    log('Message incorrectly formated');
    return;
  }
  sendBytes(hexStringToBytes(hex)).catch((err) => log(`Error sending: ${err}`));
}

/** Крок патча через прямий вибір (BLE не має MIDI-CC prev/next). */
function stepPatch(delta: number): void {
  const cur = getState().currentPatchNumber;
  let next = cur + delta;
  if (next < 0) next = 99;
  if (next > 99) next = 0;
  runtime.userChangedPatch = true;
  setState({ currentPatchNumber: next });
  sendPatchSelect(next);
}

const bleTransport: TransportDriver = {
  txPrefix: '8080',
  sendRaw: sendSysex,
  disconnect() {
    disconnectDevice().catch((err) => log(`Error disconnecting: ${err}`));
    onDisconnected();
  },
  prevPatch() {
    stepPatch(-1);
  },
  nextPatch() {
    stepPatch(1);
  },
};

function onDisconnected(): void {
  cancelHandshake();
  log('Device disconnected.');
  runtime.initialSync = true;
  setActiveTransport(null);
  setState({
    transport: null,
    connected: false,
    connecting: false,
    deviceName: '',
    locked: true,
    saveEnabled: false,
  });
}

export async function connectBluetooth(): Promise<void> {
  try {
    log('Searching BLE Device');
    const name = await connectBle();
    setActiveTransport(bleTransport);
    log(`Connected to ${name}`);
    log('Syncing: Patch list');
    setState({
      transport: 'ble',
      deviceName: name || 'GP5',
      locked: false,
      loadModalOpen: true,
    });
    awaitHandshake(); // «connected» лише після першої відповіді пристрою
    sendSysex('8080F0000E00010000000201020400F7');
  } catch (err) {
    log(`Error: ${err}`);
  }
}

export function handleNotification(bytes: number[]): void {
  if (bytes[5] === 1 && bytes[6] === 5 && bytes.length === 212) {
    runtime.dumpPatchNames[bytes[7] * 16 + bytes[8]] = bytes
      .slice(0, 211)
      .slice(11);
    return;
  }
  if (
    bytes[5] === 1 &&
    bytes[6] === 5 &&
    bytes[7] === 1 &&
    bytes[8] === 4 &&
    bytes.length === 16
  ) {
    runtime.dumpPatchNames[bytes[7] * 16 + bytes[8]] = bytes
      .slice(0, 15)
      .slice(11);
    buildPatchList();
    if (runtime.initialSync) {
      log('Syncing: Actual preset');
      sendSysex('8080f0000700010000000201020403f7');
    }
    return;
  }

  if (
    bytes[5] === 0 &&
    bytes[6] === 1 &&
    bytes[10] === 4 &&
    bytes[11] === 1 &&
    bytes[12] === 2 &&
    bytes[13] === 4 &&
    bytes[14] === 3 &&
    bytes.length === 20
  ) {
    const currentPatchNumber = bytes[15] * 16 + bytes[16];
    setState((s) => ({
      currentPatchNumber,
      currentPatchName: s.patchNames[currentPatchNumber],
    }));
    if (runtime.initialSync) {
      log('Syncing: Preset info');
      sendSysex('8080f0000900010000000201020401f7');
    }
    return;
  }

  if (
    bytes[5] === 0 &&
    bytes[6] === 6 &&
    bytes[7] === 0 &&
    bytes[8] === 5 &&
    bytes.length === 38
  ) {
    log('This editor is not compatible with the GP-50.');
    return;
  }

  if (bytes[5] === 0 && bytes[6] === 5 && bytes.length === 212) {
    log('Syncing: Preset info');
    runtime.dumpPatchInfo[bytes[7] * 16 + bytes[8]] = bytes
      .slice(0, 211)
      .slice(11);
    return;
  }
  if (
    bytes[5] === 0 &&
    bytes[6] === 5 &&
    bytes[7] === 0 &&
    bytes[8] === 4 &&
    bytes.length === 148
  ) {
    runtime.dumpPatchInfo[bytes[7] * 16 + bytes[8]] = bytes
      .slice(0, 147)
      .slice(11);
    if (runtime.initialSync) {
      log('Syncing: Global Parameters');
      applyPatch(false);
      sendSysex('8080f00b0900010000000201020100f7');
    } else {
      applyPatch(true);
    }
    return;
  }

  if (
    bytes[5] === 0 &&
    bytes[6] === 1 &&
    bytes[11] === 1 &&
    bytes[12] === 2 &&
    bytes[13] === 1 &&
    bytes.length === 166
  ) {
    log('Received Global Parameters');
    setState({
      globalCab: bytes[152],
      globalFoot: bytes[162],
      globalInput: hexToSignedInt(bytes[91] * 16 + bytes[92]),
      globalRec: hexToSignedInt(bytes[101] * 16 + bytes[102]),
      globalMon: hexToSignedInt(bytes[111] * 16 + bytes[112]),
      globalBt: hexToSignedInt(bytes[141] * 16 + bytes[142]),
      globalVol: hexToSignedInt(bytes[55] * 16 + bytes[56]),
    });
    if (runtime.initialSync) {
      log('Syncing: Preset status');
      sendSysex('8080f0010500010000000201020405f7');
    }
    return;
  }

  if (
    bytes[5] === 0 &&
    bytes[6] === 1 &&
    bytes[10] === 3 &&
    bytes[11] === 1 &&
    bytes[12] === 2 &&
    bytes[13] === 4 &&
    bytes[14] === 5 &&
    bytes.length === 18
  ) {
    runtime.patchChanged = bytes[16];
    setState({ saveEnabled: Boolean(runtime.patchChanged) });
    if (runtime.initialSync) {
      log("Syncing: IR's");
      sendSysex('8080f0020900010000000201020200f7');
    }
    return;
  }
  if (bytes[5] === 0 && bytes[6] === 4 && bytes.length === 212) {
    runtime.dumpIR[bytes[7] * 16 + bytes[8]] = bytes.slice(0, 211).slice(11);
    return;
  }
  if (bytes[5] === 0 && bytes[6] === 4 && bytes.length === 96) {
    runtime.dumpIR[bytes[7] * 16 + bytes[8]] = bytes.slice(0, 95).slice(11);
    const d = runtime.dumpIR.flat(1);
    const models: string[] = [];
    let t = 44;
    for (let index = 0; index < 20; index++) {
      models.push(getName(d, t));
      t += 32;
    }
    setState({ cabModels: models });
    if (runtime.initialSync) {
      log("Syncing: Nam's");
      sendSysex('8080f0030500010000000201020204f7');
    }
    return;
  }

  if (bytes[5] === 0 && bytes[6] === 14 && bytes.length === 212) {
    runtime.dumpSnaptones[bytes[7] * 16 + bytes[8]] = bytes
      .slice(0, 211)
      .slice(11);
    return;
  }
  if (bytes[5] === 0 && bytes[6] === 14 && bytes.length === 136) {
    runtime.dumpSnaptones[bytes[7] * 16 + bytes[8]] = bytes
      .slice(0, 135)
      .slice(11);
    const d = runtime.dumpSnaptones.flat(1);
    const models: string[] = [];
    let t = 164;
    for (let index = 0; index < 80; index++) {
      models.push(getName(d, t));
      t += 32;
    }
    setState({ nsModels: models });
    if (runtime.initialSync) {
      setState({ loadModalOpen: false, locked: false });
      log('GP5: Synced');
      runtime.initialSync = false;
    }
    return;
  }

  if (
    bytes[5] === 0 &&
    bytes[6] === 1 &&
    bytes[11] === 1 &&
    bytes[12] === 2 &&
    bytes[13] === 4 &&
    bytes[14] === 3 &&
    bytes.length === 24
  ) {
    log('GP5 -> Change patch');
    const currentPatchNumber = bytes[15] * 16 + bytes[16];
    setState((s) => ({
      currentPatchNumber,
      currentPatchName: s.patchNames[currentPatchNumber],
    }));
    sendSysex('8080f0000900010000000201020401f7');
    return;
  }

  if (
    bytes[5] === 0 &&
    bytes[6] === 1 &&
    bytes[10] === 3 &&
    bytes[11] === 1 &&
    bytes[12] === 4 &&
    bytes[14] === 8 &&
    bytes.length === 18
  ) {
    log('Command received');
    if (runtime.userChangedPatch) {
      if (getState().globalBPMOn) {
        sendParamChange(7, 1, getState().delayTime);
      }
      sendSysex('8080f0000900010000000201020401f7');
      runtime.userChangedPatch = false;
    }
    return;
  }

  if (
    bytes[5] === 0 &&
    bytes[6] === 1 &&
    bytes[10] === 3 &&
    bytes[11] === 1 &&
    bytes[12] === 4 &&
    bytes[13] === 0 &&
    bytes[14] === 5 &&
    bytes.length === 18
  ) {
    runtime.patchChanged = bytes[17];
    return;
  }

  if (
    bytes[5] === 0 &&
    bytes[6] === 1 &&
    bytes[12] === 2 &&
    bytes[13] === 4 &&
    bytes[14] === 14 &&
    bytes.length === 24
  ) {
    log('GP5 -> CTL pressed');
    const enabled = [
      Boolean(bytes[16] & (1 << 0)), // nr
      Boolean(bytes[16] & (1 << 1)), // pre
      Boolean(bytes[16] & (1 << 2)), // dst
      Boolean(bytes[16] & (1 << 3)), // amp
      Boolean(bytes[15] & (1 << 0)), // cab
      Boolean(bytes[15] & (1 << 1)), // eq
      Boolean(bytes[15] & (1 << 2)), // mod
      Boolean(bytes[15] & (1 << 3)), // dly
      Boolean(bytes[18] & (1 << 0)), // rvb
      Boolean(bytes[18] & (1 << 1)), // ns
    ];
    setState({ enabled });
    return;
  }

  if (
    bytes[5] === 0 &&
    bytes[6] === 1 &&
    bytes[10] === 7 &&
    bytes[11] === 1 &&
    bytes[12] === 2 &&
    bytes.length === 26
  ) {
    log('GP5 -> Change global');
    const v = hexToSignedInt(bytes[23] * 16 + bytes[24]);
    const patch: Record<string, number> = {};
    if (bytes[16] === 1 && bytes[18] === 3) patch.globalInput = v;
    if (bytes[16] === 3 && bytes[18] === 3) patch.globalCab = v;
    if (bytes[16] === 1 && bytes[18] === 4) patch.globalRec = v;
    if (bytes[16] === 5 && bytes[18] === 4) patch.globalBt = v;
    if (bytes[16] === 2 && bytes[18] === 4) patch.globalMon = v;
    if (bytes[16] === 2 && bytes[18] === 2) patch.globalVol = v;
    setState(patch);
    return;
  }

  if (
    bytes[5] === 0 &&
    bytes[6] === 1 &&
    bytes[10] === 10 &&
    bytes[11] === 1 &&
    bytes[12] === 2 &&
    bytes.length === 32
  ) {
    log('GP5 -> vol global');
    if (bytes[16] === 2 && bytes[18] === 2) {
      setState({ globalVol: hexToSignedInt(bytes[23] * 16 + bytes[24]) });
    }
    return;
  }

  if (
    bytes[5] === 0 &&
    bytes[6] === 1 &&
    bytes[10] === 4 &&
    bytes[11] === 1 &&
    bytes[12] === 2 &&
    bytes[13] === 1 &&
    bytes[14] === 5 &&
    bytes.length === 20
  ) {
    log('GP5 -> footswitch mode');
    setState({ globalFoot: hexToSignedInt(bytes[17] * 16 + bytes[18]) });
    return;
  }
}

export { onDisconnected };
