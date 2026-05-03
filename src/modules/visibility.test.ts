import { describe, expect, it } from 'vitest';
import type { ModuleDefinition } from './types';
import { PROTECTED_MODULE_ID, resolveVisibleModules } from './visibility';

const make = (id: string): ModuleDefinition => ({ id, title: id });

const sample: ModuleDefinition[] = [
  make('clipboard'),
  make('downloads'),
  make('notes'),
  make('separator'),
  make('metronome'),
  make(PROTECTED_MODULE_ID),
];

describe('resolveVisibleModules', () => {
  it('returns registry order with Settings last by default', () => {
    const out = resolveVisibleModules(sample, { hiddenModules: [], moduleOrder: [] });
    expect(out.map((m) => m.id)).toEqual([
      'clipboard',
      'downloads',
      'notes',
      'separator',
      'metronome',
      PROTECTED_MODULE_ID,
    ]);
  });

  it('filters out hidden modules', () => {
    const out = resolveVisibleModules(sample, {
      hiddenModules: ['separator', 'metronome'],
      moduleOrder: [],
    });
    expect(out.map((m) => m.id)).toEqual([
      'clipboard',
      'downloads',
      'notes',
      PROTECTED_MODULE_ID,
    ]);
  });

  it('honours moduleOrder before falling back to registry order', () => {
    const out = resolveVisibleModules(sample, {
      hiddenModules: [],
      moduleOrder: ['notes', 'clipboard'],
    });
    expect(out.map((m) => m.id)).toEqual([
      'notes',
      'clipboard',
      'downloads',
      'separator',
      'metronome',
      PROTECTED_MODULE_ID,
    ]);
  });

  it('cannot hide Settings even if listed in hiddenModules', () => {
    const out = resolveVisibleModules(sample, {
      hiddenModules: [PROTECTED_MODULE_ID],
      moduleOrder: [],
    });
    expect(out.map((m) => m.id)).toContain(PROTECTED_MODULE_ID);
    expect(out[out.length - 1].id).toBe(PROTECTED_MODULE_ID);
  });

  it('keeps Settings last even when reordered to the front', () => {
    const out = resolveVisibleModules(sample, {
      hiddenModules: [],
      moduleOrder: [PROTECTED_MODULE_ID, 'metronome'],
    });
    expect(out.map((m) => m.id)).toEqual([
      'metronome',
      'clipboard',
      'downloads',
      'notes',
      'separator',
      PROTECTED_MODULE_ID,
    ]);
  });

  it('drops unknown ids silently', () => {
    const out = resolveVisibleModules(sample, {
      hiddenModules: ['ghost'],
      moduleOrder: ['notes', 'phantom', 'clipboard'],
    });
    expect(out.map((m) => m.id)).toEqual([
      'notes',
      'clipboard',
      'downloads',
      'separator',
      'metronome',
      PROTECTED_MODULE_ID,
    ]);
  });

  it('deduplicates repeated ids in moduleOrder', () => {
    const out = resolveVisibleModules(sample, {
      hiddenModules: [],
      moduleOrder: ['notes', 'notes', 'clipboard', 'notes'],
    });
    expect(out.map((m) => m.id)).toEqual([
      'notes',
      'clipboard',
      'downloads',
      'separator',
      'metronome',
      PROTECTED_MODULE_ID,
    ]);
  });
});
