/* Низькорівневі хелпери протоколу GP-5 (порт js/utils.js, без змін логіки). */

export function crc8(bytes: number[]): number {
  let crc = 0x00;
  for (let i = 0; i < bytes.length; i++) {
    const cur = bytes[i] & 0xff;
    crc ^= cur;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x80) !== 0) {
        crc = ((crc << 1) ^ 0x07) & 0xff;
      } else {
        crc = (crc << 1) & 0xff;
      }
    }
  }
  return crc & 0xff;
}

export function hexStringToBytes(hexString: string): number[] {
  const bytes: number[] = [];
  const clean = hexString.replace(/\s+/g, '');
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substr(i, 2), 16));
  }
  return bytes;
}

export function stringToHexArray(str: string): string[] {
  const bytes: string[] = [];
  for (let i = 0; i < str.length; i++) {
    const hex = str.charCodeAt(i).toString(16).toUpperCase();
    bytes.push(hex.padStart(2, '0'));
  }
  return bytes;
}

export function generateVerifier(hexData: string): number {
  const bytes = hexStringToBytes(hexData);
  return crc8(bytes);
}

export function eliminateOddCharacters(str: string): string {
  let newString = '';
  for (let i = 0; i < str.length; i++) {
    if (i % 2 !== 0) {
      newString += str[i];
    }
  }
  return newString;
}

export function addzero(str: string): string {
  let newString = '';
  for (let i = 0; i < str.length; i++) {
    newString += `0${str[i]}`;
  }
  return newString;
}

export function floatToHexBytes(value: number): string[] {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true);
  return Array.from(new Uint8Array(buffer)).map((b) =>
    b.toString(16).padStart(2, '0'),
  );
}

export function hexBytesToFloat(input: number[], littleEndian = true): number {
  const bytes = input;
  const buffer = new ArrayBuffer(4);
  const u8 = new Uint8Array(buffer);

  for (let i = 0; i < 4; i++) u8[i] = bytes[i * 2] * 16 + bytes[i * 2 + 1];

  const dv = new DataView(buffer);
  return dv.getFloat32(0, littleEndian);
}

export function hexToSignedInt(hex: number): number {
  if (hex & 0x80) {
    hex = hex - 0x100;
  }
  return hex;
}

export function signedIntToHex(num: number): string {
  if (num < -128 || num > 127) {
    throw new RangeError('El número debe estar entre -128 y 127.');
  }
  if (num < 0) {
    num = 0x100 + num;
  }
  return num.toString(16).toUpperCase().padStart(2, '0');
}

export function roundToStep(value: number, step: number): number {
  const s = Number(step) || 1;
  const rounded = Math.round(Number(value) / s) * s;
  const decimals = (String(s).split('.')[1] || '').length;
  return Number(rounded.toFixed(decimals));
}

export function cleanName(input: string): string {
  const clean = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 -]/g, '');
  return clean.slice(0, 10);
}

/** Назва пресету з 20 байтів (10 символів по 2 ніблі), порожні → пробіл. */
export function getName(bytes: number[], start: number): string {
  let n = '';
  let t = 0;
  for (let i = 0; i < 20; i = i + 2) {
    t = bytes[i + start] * 16 + bytes[i + start + 1];
    if (t === 0) {
      t = 32;
    }
    n = n + String.fromCharCode(t);
  }
  return n;
}

/** 8-байтовий ідентифікатор моделі ефекту як hex-рядок. */
export function getEffectId(bytes: number[], start: number): string {
  let n = '';
  for (let i = 0; i < 8; i++) {
    n = n + bytes[start + i].toString(16).toLowerCase();
  }
  return n;
}
