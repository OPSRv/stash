/* Транспортна абстракція: один активний драйвер (BLE або USB-MIDI).
   Драйвер реєструє себе через setActiveTransport. Спільні відправники (protocol.ts)
   формують лише тіло команди і викликають sendCommand(); обрамлення (BLE: "8080F0…F7",
   USB: "F0…F7") додає активний драйвер. */

export interface TransportDriver {
  txPrefix: string;
  sendRaw: (hex: string) => void;
  disconnect?: () => void;
  prevPatch?: () => void;
  nextPatch?: () => void;
}

let active: TransportDriver | null = null;

export function setActiveTransport(driver: TransportDriver | null): void {
  active = driver;
}
export function getActiveTransport(): TransportDriver | null {
  return active;
}
export function isConnected(): boolean {
  return !!active;
}

/** Відправити «сире» повністю сформоване sysex-повідомлення (як є). */
export function sendRaw(hex: string): void {
  if (active) active.sendRaw(hex);
}

/** Відправити команду GP-5 (тіло без обрамлення) — драйвер додасть свій префікс/F0…F7. */
export function sendCommand(finalHex: string): void {
  if (active) active.sendRaw(`${active.txPrefix}F0${finalHex}F7`);
}

export function disconnect(): void {
  if (active?.disconnect) active.disconnect();
}

export function prevPatch(): void {
  if (active?.prevPatch) active.prevPatch();
}

export function nextPatch(): void {
  if (active?.nextPatch) active.nextPatch();
}
