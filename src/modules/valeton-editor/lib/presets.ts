/* Збереження поточного патча у файл .prst (порт js/presets.js).
   У Tauri/WKWebView браузерне `<a download>` не працює, тож шлях обирається
   через нативний save-діалог, а байти пише Rust (valeton_save_file). */
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { saveFileBytes } from '../api';
import { getState, log } from '../store/store';
import { runtime } from './runtime';
import { generateVerifier, stringToHexArray } from './utils';

/* Тимчасово вимикаємо авто-приховування popup, поки відкритий нативний діалог
   (інакше клік по діалогу блюрить popup і ховає його). */
const withAutoHideSuspended = async <T>(fn: () => Promise<T>): Promise<T> => {
  await invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
  try {
    return await fn();
  } finally {
    await invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
  }
};

export async function savePresetFile(): Promise<void> {
  const s = getState();
  const headerGP50 = '47502D3530000000000000000000000000000100';
  const headerGP5 = '47502D3500000000000000000000000000000100';
  let checksum = 'XX';
  const spacer = 'FFFFFFFF';
  let name = '';
  const descriptor = '000000000000';
  const descriptorGP50 =
    '000000000000FF0010000100040001000000020004004750353000001000011004000A000000021004000800000001003B000120010032022004007800000003200100000420040000000000052004006400000006200100000720010000082001006409200100000A2001';
  let patch = '';
  const endGP50 = '0505';
  let convertedFile = '';
  let prstIni = '';

  const nameArray = stringToHexArray(s.patchNames[s.currentPatchNumber] ?? '');
  for (let index = 0; index < 10; index++) {
    if (nameArray[index] === '20') nameArray[index] = '00';
    name = name + (nameArray[index] ?? '00');
  }
  const data = runtime.dumpPatchInfo.flat(1);

  if (runtime.saveGp5) {
    for (let index = 4; index < data.length; index = index + 2) {
      patch += `${data[index].toString(16)}${data[index + 1].toString(16)}`;
    }
    checksum = generateVerifier(spacer + name + descriptor + patch)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
    convertedFile = headerGP5 + checksum + spacer + name + descriptor + patch;
    prstIni = 'gp5_';
  }
  if (runtime.saveGp50) {
    for (let index = 120; index < data.length; index = index + 2) {
      patch += `${data[index].toString(16)}${data[index + 1].toString(16)} `;
    }
    checksum = generateVerifier(
      spacer + name + descriptorGP50 + patch + endGP50,
    )
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
    convertedFile =
      headerGP50 + checksum + spacer + name + descriptorGP50 + patch + endGP50;
    prstIni = 'gp50_';
  }

  runtime.saveGp5 = false;
  runtime.saveGp50 = false;

  const hexValues = convertedFile.match(/[0-9a-fA-F]{2}/g);
  if (!hexValues) {
    log('No valid HEX bytes found for the preset.');
    return;
  }

  const bytes: number[] = hexValues.map((h) => Number.parseInt(h, 16));
  const fileName = `${prstIni}${s.currentPatchNumber.toString().padStart(2, '0')}-${
    s.patchNames[s.currentPatchNumber] ?? ''
  }.prst`;

  try {
    const path = await withAutoHideSuspended(() =>
      saveDialog({
        defaultPath: fileName,
        filters: [{ name: 'GP preset', extensions: ['prst'] }],
      }),
    );
    if (!path) return;
    await saveFileBytes(path, bytes);
    log(`Preset saved: ${fileName}`);
  } catch (err) {
    log(`Error saving preset: ${err}`);
  }
}
