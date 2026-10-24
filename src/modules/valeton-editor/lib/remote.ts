/* Виконання віддалених команд асистента (Telegram / CLI / голос).
   Rust-команда `/valeton` емітить подію `valeton:remote` з частковим payload;
   тут ми мапимо кожне задане поле на ту саму високорівневу дію, яку викликає
   UI (`actions.ts`), тож поведінка ідентична ручному редагуванню. Девайс-I/O
   best-effort: якщо GP-5 не підключений, стор оновлюється, а команди підуть на
   пристрій при наступному з'єднанні. */
import {
  importPreset,
  savePatchToDevice,
  selectPatch,
  setBpm,
  setDivision,
  toggleBlock,
} from './actions';
import { BLOCK_BY_KEY } from './blocks';
import { parsePreset } from './presetIO';
import type { BlockKey } from '../store/types';

/** Payload події `valeton:remote` (дзеркалить `ValetonRemote` у Rust). */
export interface ValetonRemote {
  // Rust serialises unset `Option` fields as `null`, hence `| null`.
  patch?: number | null;
  bpm?: number | null;
  division?: 'quarter' | 'eighth' | 'dotted' | null;
  block?: string | null;
  block_on?: boolean | null;
  save?: boolean | null;
  /** JSON AI-пресета (від `/valeton tone …`) для розбору + застосування. */
  preset_json?: string | null;
  /** Echoed back on `valeton:remote:ack`; re-emits reuse the same id. */
  ack_id?: number | null;
}

const isBlockKey = (k: string): k is BlockKey => k in BLOCK_BY_KEY;

/** Застосувати віддалену команду. Поля обробляються в порядку, що мінімізує
    гонки: вибір патча (тригерить дамп з пристрою) → AI-пресет → темп → блок →
    збереження. */
export async function applyValetonRemote(p: ValetonRemote): Promise<void> {
  if (p.patch != null) selectPatch(p.patch);

  if (p.preset_json) {
    const res = parsePreset(p.preset_json);
    if (res.ok) {
      const applied = importPreset(res.preset);
      if (applied) await applied; // дочекатися, поки вся пачка піде на пристрій
    }
  }

  if (p.bpm != null) setBpm(p.bpm);
  if (p.division != null) setDivision(p.division);

  if (p.block && p.block_on != null && isBlockKey(p.block)) {
    toggleBlock(p.block, p.block_on);
  }

  if (p.save) await savePatchToDevice({ skipConfirm: true });
}
