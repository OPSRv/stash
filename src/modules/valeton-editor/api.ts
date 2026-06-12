/* Тонка обгортка над Rust-транспортом (USB-MIDI / BLE). WKWebView не має ні
   Web MIDI, ні Web Bluetooth, тож сире байтове I/O живе в Rust (`valeton`
   модуль), а весь протокол GP-5 лишається у фронтенді. Компоненти ніколи не
   викликають invoke напряму — лише через ці хелпери. */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type ValetonTransportKind = 'usb' | 'ble';

/** Подія `valeton:rx` — сирі вхідні байти від пристрою (sysex / BLE-нотифікація). */
export interface ValetonRxEvent {
  transport: ValetonTransportKind;
  bytes: number[];
}

/** Під'єднатися по USB-MIDI; повертає назву пристрою або кидає помилку. */
export const connectUsb = (): Promise<string> =>
  invoke<string>('valeton_connect_usb');

/** Під'єднатися по Bluetooth LE; повертає назву пристрою або кидає помилку. */
export const connectBle = (): Promise<string> =>
  invoke<string>('valeton_connect_ble');

/** Надіслати повністю сформоване (обрамлене транспортом) повідомлення у байтах. */
export const sendBytes = (bytes: number[]): Promise<void> =>
  invoke('valeton_send', { bytes });

/** Розірвати активне з'єднання (USB або BLE). */
export const disconnectDevice = (): Promise<void> =>
  invoke('valeton_disconnect');

/** Чи присутній зараз USB-MIDI порт GP-5? Тихий пробінг для авто-підключення,
    коли процесор вмикають уже після відкриття програми (без спаму в лог). */
export const usbPresent = (): Promise<boolean> =>
  invoke<boolean>('valeton_usb_present').catch(() => false);

/** Записати .prst-файл на диск (WKWebView не вміє `<a download>`). */
export const saveFileBytes = (path: string, bytes: number[]): Promise<void> =>
  invoke('valeton_save_file', { path, bytes });

/** Згенерувати пресет через AI-асистента (Rust шле спеку + запит у LLM).
    Повертає сирий текст відповіді — JSON парситься на фронтенді. */
export const generatePreset = (prompt: string): Promise<string> =>
  invoke<string>('valeton_generate_preset', { prompt });

/** Пін/анпін авто-сховання попапа навколо нативних діалогів (`confirm`,
    file-picker): без цього blur ховає попап і скасовує діалог. Див. CLAUDE.md. */
export const setPopupAutoHide = (enabled: boolean): Promise<void> =>
  invoke<void>('set_popup_auto_hide', { enabled }).catch(() => {});

/** Підписка на вхідні байти. */
export const onRx = (cb: (e: ValetonRxEvent) => void): Promise<UnlistenFn> =>
  listen<ValetonRxEvent>('valeton:rx', (e) => cb(e.payload));

/** Підписка на раптове від'єднання пристрою з боку Rust. */
export const onDeviceDisconnected = (cb: () => void): Promise<UnlistenFn> =>
  listen('valeton:disconnected', () => cb());
