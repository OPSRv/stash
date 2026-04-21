import { describe, expect, it } from 'vitest';
import { HEAVY_RSS_BYTES, formatBytes, formatCpu } from './format';

describe('formatBytes', () => {
  it('formats bytes, KB, MB, GB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50.0 MB');
    expect(formatBytes(1500 * 1024 * 1024)).toBe('1.46 GB');
  });
  it('drops decimal for ≥100 MB so columns stay narrow', () => {
    expect(formatBytes(600 * 1024 * 1024)).toBe('600 MB');
  });
});

describe('formatCpu', () => {
  it('uses one decimal under 10%, none above', () => {
    expect(formatCpu(3.42)).toBe('3.4%');
    expect(formatCpu(12.7)).toBe('13%');
  });
});

describe('HEAVY_RSS_BYTES', () => {
  it('is 500 MiB', () => {
    expect(HEAVY_RSS_BYTES).toBe(500 * 1024 * 1024);
  });
});
