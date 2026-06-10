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
  patch?: number;
  bpm?: number;
  division?: 'quarter' | 'eighth' | 'dotted';
  block?: string;
  block_on?: boolean;
  save?: boolean;
  /** JSON AI-пресета (від `/valeton tone …`) для розбору + застосування. */
  preset_json?: string;
}

const isBlockKey = (k: string): k is BlockKey => k in BLOCK_BY_KEY;

/** Застосувати віддалену команду. Поля обробляються в порядку, що мінімізує
    гонки: вибір патча (тригерить дамп з пристрою) → AI-пресет → темп → блок →
    збереження. */
export async function applyValetonRemote(p: ValetonRemote): Promise<void> {
  if (p.patch !== undefined) selectPatch(p.patch);

  if (p.preset_json) {
    const res = parsePreset(p.preset_json);
    if (res.ok) {
      const applied = importPreset(res.preset);
      if (applied) await applied; // дочекатися, поки вся пачка піде на пристрій
    }
  }

  if (p.bpm !== undefined) setBpm(p.bpm);
  if (p.division !== undefined) setDivision(p.division);

  if (p.block && p.block_on !== undefined && isBlockKey(p.block)) {
    toggleBlock(p.block, p.block_on);
  }

  if (p.save) await savePatchToDevice({ skipConfirm: true });
}
