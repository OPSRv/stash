import { describe, it, expect } from 'vitest';

import {
  consumeSettingsSection,
  requestSettingsSection,
} from './pendingSettingsSection';

describe('pendingSettingsSection', () => {
  it('returns null when nothing was requested', () => {
    // Drain anything left over from another test before asserting.
    consumeSettingsSection();
    expect(consumeSettingsSection()).toBeNull();
  });

  it('hands off the requested id once', () => {
    requestSettingsSection('telegram');
    expect(consumeSettingsSection()).toBe('telegram');
    // Slot empties on read so a later mount can't accidentally
    // re-trigger the section flip.
    expect(consumeSettingsSection()).toBeNull();
  });

  it('latest request wins when not consumed', () => {
    requestSettingsSection('terminal');
    requestSettingsSection('telegram');
    expect(consumeSettingsSection()).toBe('telegram');
  });
});
