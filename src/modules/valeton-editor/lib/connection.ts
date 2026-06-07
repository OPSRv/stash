/* Підтвердження живого підключення.

   Сам факт відкриття MIDI-порту з назвою «GP-5» ще НЕ означає, що пристрій
   увімкнено й він відповідає: на macOS така CoreMIDI-точка може існувати й без
   ввімкненого пристрою (напр. збережена Bluetooth-MIDI точка в Audio MIDI Setup
   лишається в системі постійно). Тож «connected» виставляємо лише після першої
   вхідної відповіді на рукостискання. Якщо відповіді немає за таймаут — вважаємо,
   що пристрою немає, і повертаємось в офлайн. */
import { getState, log, setState } from '../store/store';
import { disconnect } from './transport';

const HANDSHAKE_TIMEOUT_MS = 3000;

let timer: ReturnType<typeof setTimeout> | null = null;

/** Порт відкрито, рукостискання надіслано — чекаємо на відповідь пристрою. */
export function awaitHandshake(): void {
  cancelHandshake();
  setState({ connecting: true, connected: false });
  timer = setTimeout(() => {
    timer = null;
    if (!getState().connecting) return; // вже підтверджено / від'єднано
    setState({ connecting: false });
    disconnect(); // прибрати «привидний» порт …
    log('No response from GP-5 — make sure it is powered on and connected.'); // … і лишити зрозумілий статус
  }, HANDSHAKE_TIMEOUT_MS);
}

/** Будь-яка вхідна відповідь підтверджує живий пристрій. */
export function confirmHandshake(): void {
  if (!getState().connecting) return; // підтверджуємо лише активну спробу
  cancelHandshake();
  setState({ connecting: false, connected: true });
}

/** Скинути очікування рукостискання (при від'єднанні / повторному конекті). */
export function cancelHandshake(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
