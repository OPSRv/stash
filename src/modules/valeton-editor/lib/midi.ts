/* USB-драйвер (MIDI sysex через Rust-міст). Транспортно-специфічне: connect/
   disconnect, відправлення байтів, розбір вхідних MIDI-повідомлень (зміщення
   bytes[3]/[4]). Спільне (відправники, parsePatchInfo) — у protocol.ts.
   Сире байтове I/O делегується Rust (api.ts), бо WKWebView не має Web MIDI. */
import { connectUsb, disconnectDevice, sendBytes } from '../api';
import { getState, log, setState } from '../store/store';
import { sendParamChange } from './protocol';
import { runtime } from './runtime';
import { applyPatch, buildPatchList } from './sync';
import { setActiveTransport, type TransportDriver } from './transport';
import { getName, hexStringToBytes, hexToSignedInt } from './utils';

/* сире надсилання повністю сформованого sysex через Rust-міст */
function sendSysex(sysex: string): void {
  const hex = sysex.trim().replace(/[^0-9a-fA-F]/g, '');
  if (hex.length % 2 !== 0) {
    log('Message incorrectly formated');
    return;
  }
  sendBytes(hexStringToBytes(hex)).catch((err) => log(`Error sending: ${err}`));
}

const midiTransport: TransportDriver = {
  txPrefix: '',
  sendRaw: sendSysex,
  disconnect: disconnectMidi,
  prevPatch() {
    runtime.userChangedPatch = true;
    sendSysex('B01800');
  },
  nextPatch() {
    runtime.userChangedPatch = true;
    sendSysex('B01900');
  },
};

function disconnectGUI(): void {
  log('Connection closed.');
  setActiveTransport(null);
  setState({
    transport: null,
    connected: false,
    deviceName: '',
    locked: true,
    saveEnabled: false,
  });
  runtime.initialSync = true;
}

export function disconnectMidi(): void {
  disconnectDevice().catch((err) => log(`Error disconnecting: ${err}`));
  disconnectGUI();
}

export async function connectMidi(): Promise<void> {
  try {
    log('Searching USB MIDI…');
    const name = await connectUsb();
    setActiveTransport(midiTransport);
    log(`Input MIDI: ${name}`);
    log('Syncing: Patch list');
    setState({
      transport: 'usb',
      connected: true,
      deviceName: name || 'GP-5',
      locked: false,
    });
    sendSysex('F0000E00010000000201020400F7');
  } catch (err) {
    log(`Error: ${err}`);
  }
}

export function handleMIDIMessage(bytes: number[]): void {
  if (bytes[3] === 6 && bytes[4] === 10 && bytes.length === 48) {
    runtime.dumpPatchNames[bytes[5] * 16 + bytes[6]] = bytes
      .slice(0, 47)
      .slice(9);
    return;
  }
  if (bytes[3] === 6 && bytes[4] === 10 && bytes.length === 24) {
    runtime.dumpPatchNames[bytes[5] * 16 + bytes[6]] = bytes
      .slice(0, 23)
      .slice(9);
    buildPatchList();
    if (runtime.initialSync) {
      log('Syncing: Actual preset');
      sendSysex('f0000700010000000201020403f7');
    }
    return;
  }

  if (
    bytes[3] === 0 &&
    bytes[4] === 1 &&
    bytes[8] === 4 &&
    bytes[9] === 1 &&
    bytes[10] === 2 &&
    bytes[11] === 4 &&
    bytes[12] === 3 &&
    bytes.length === 18
  ) {
    const currentPatchNumber = bytes[13] * 16 + bytes[14];
    setState((s) => ({
      currentPatchNumber,
      currentPatchName: s.patchNames[currentPatchNumber],
    }));
    if (runtime.initialSync || runtime.userChangedPatch) {
      log('Syncing: Preset info');
      sendSysex('f0000900010000000201020401f7');
    }
  }

  if (bytes[3] === 1 && bytes[4] === 9 && bytes.length === 48) {
    runtime.dumpPatchInfo[bytes[5] * 16 + bytes[6]] = bytes
      .slice(0, 47)
      .slice(9);
    return;
  }
  if (bytes[3] === 1 && bytes[4] === 9 && bytes.length === 34) {
    runtime.dumpPatchInfo[bytes[5] * 16 + bytes[6]] = bytes
      .slice(0, 33)
      .slice(9);
    if (runtime.initialSync) {
      log('Syncing: Global Parameters');
      applyPatch(false);
      sendSysex('f00b0900010000000201020100f7');
    } else {
      applyPatch(true);
    }
    return;
  }

  if (bytes[3] === 0 && bytes[4] === 5 && bytes.length === 48) {
    log('Received Global Parameters');
    runtime.dumpGlobal[bytes[5] * 16 + bytes[6]] = bytes.slice(0, 47).slice(9);
    return;
  }
  if (bytes[3] === 0 && bytes[4] === 5 && bytes.length === 12) {
    runtime.dumpGlobal[bytes[5] * 16 + bytes[6]] = bytes.slice(0, 11).slice(9);
    const data = runtime.dumpGlobal.flat(1);
    setState({
      globalCab: data[141],
      globalFoot: data[151],
      globalInput: hexToSignedInt(data[80] * 16 + data[81]),
      globalRec: hexToSignedInt(data[90] * 16 + data[91]),
      globalMon: hexToSignedInt(data[100] * 16 + data[101]),
      globalBt: hexToSignedInt(data[130] * 16 + data[131]),
      globalVol: hexToSignedInt(data[44] * 16 + data[45]),
    });
    if (runtime.initialSync) {
      log('Syncing: Preset status');
      sendSysex('f0010500010000000201020405f7');
    }
    return;
  }

  if (
    bytes[3] === 0 &&
    bytes[4] === 1 &&
    bytes[8] === 3 &&
    bytes[9] === 1 &&
    bytes[10] === 2 &&
    bytes[11] === 4 &&
    bytes[12] === 5 &&
    bytes.length === 16
  ) {
    runtime.patchChanged = bytes[14];
    setState({ saveEnabled: Boolean(runtime.patchChanged) });
    if (runtime.initialSync) {
      log("Syncing: IR's");
      sendSysex('f0020900010000000201020200f7');
    }
    return;
  }
  if (bytes[3] === 1 && bytes[4] === 2 && bytes.length === 48) {
    runtime.dumpIR[bytes[5] * 16 + bytes[6]] = bytes.slice(0, 47).slice(9);
    if (bytes[5] === 1 && bytes[6] === 1) {
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
        sendSysex('f0030500010000000201020204f7');
      }
    }
    return;
  }

  if (bytes[3] === 4 && bytes[4] === 8 && bytes.length === 48) {
    runtime.dumpSnaptones[bytes[5] * 16 + bytes[6]] = bytes
      .slice(0, 47)
      .slice(9);
    return;
  }
  if (bytes[3] === 4 && bytes[4] === 8 && bytes.length === 36) {
    runtime.dumpSnaptones[bytes[5] * 16 + bytes[6]] = bytes
      .slice(0, 35)
      .slice(9);
    const d = runtime.dumpSnaptones.flat(1);
    const models: string[] = [];
    let t = 164;
    for (let index = 0; index < 80; index++) {
      models.push(getName(d, t));
      t += 32;
    }
    setState({ nsModels: models });
    if (runtime.initialSync) {
      log('GP5: Synced');
      setState({ locked: false });
      runtime.initialSync = false;
    }
    return;
  }

  if (
    bytes[3] === 0 &&
    bytes[4] === 1 &&
    bytes[9] === 1 &&
    bytes[10] === 2 &&
    bytes[11] === 1 &&
    bytes[12] === 11 &&
    bytes.length === 22
  ) {
    log('GP5 -> Change patch');
    runtime.userChangedPatch = true;
    sendSysex('f0000700010000000201020403f7');
    return;
  }

  if (
    bytes[3] === 0 &&
    bytes[4] === 1 &&
    bytes[8] === 3 &&
    bytes[9] === 1 &&
    bytes[10] === 4 &&
    bytes[12] === 8 &&
    bytes.length === 16
  ) {
    log('Command received');
    if (runtime.userChangedPatch) {
      if (getState().globalBPMOn) {
        const s = getState();
        sendParamChange(7, 1, s.delayTime);
      }
      sendSysex('f0000900010000000201020401f7');
      runtime.userChangedPatch = false;
    }
    return;
  }

  if (
    bytes[3] === 0 &&
    bytes[4] === 1 &&
    bytes[8] === 3 &&
    bytes[9] === 1 &&
    bytes[10] === 4 &&
    bytes[11] === 0 &&
    bytes[12] === 8 &&
    bytes.length === 16
  ) {
    runtime.patchChanged = 1;
    setState({ saveEnabled: true });
    return;
  }
}
