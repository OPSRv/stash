import { AiPromptPanel } from '../modules/telegram/sections/AiPromptPanel';
import { ConnectionPanel } from '../modules/telegram/sections/ConnectionPanel';
import { MemoryPanel } from '../modules/telegram/sections/MemoryPanel';
import { NotificationsPanel } from '../modules/telegram/sections/NotificationsPanel';
import { SettingsSection, SettingsTab } from './SettingsLayout';

/// Settings host for everything Telegram-related *except* the inbox —
/// the inbox stays on its own top-level tab so it stays reachable from
/// the popup without two clicks.
export const TelegramTab = () => (
  <SettingsTab>
    <SettingsSection label="CONNECTION">
      <ConnectionPanel />
    </SettingsSection>
    <SettingsSection label="NOTIFICATIONS">
      <NotificationsPanel />
    </SettingsSection>
    <SettingsSection label="MEMORY">
      <MemoryPanel />
    </SettingsSection>
    <SettingsSection label="AI PROMPT">
      <AiPromptPanel />
    </SettingsSection>
  </SettingsTab>
);
