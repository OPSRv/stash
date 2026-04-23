import { describe, expect, it } from 'vitest';

import { zoneFromPoint } from './useDrag';

const rect = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => '' } as DOMRect;

describe('zoneFromPoint', () => {
  it('tab targets always resolve to center', () => {
    expect(zoneFromPoint(50, 50, rect, 'tab')).toBe('center');
    expect(zoneFromPoint(5, 5, rect, 'tab')).toBe('center');
    expect(zoneFromPoint(95, 95, rect, 'tab')).toBe('center');
  });

  it('20 % edge margins pick left/right/top/bottom', () => {
    expect(zoneFromPoint(10, 50, rect, 'pane')).toBe('left');
    expect(zoneFromPoint(90, 50, rect, 'pane')).toBe('right');
    expect(zoneFromPoint(50, 10, rect, 'pane')).toBe('top');
    expect(zoneFromPoint(50, 90, rect, 'pane')).toBe('bottom');
  });

  it('interior maps to center', () => {
    expect(zoneFromPoint(50, 50, rect, 'pane')).toBe('center');
    expect(zoneFromPoint(40, 60, rect, 'pane')).toBe('center');
  });
});
