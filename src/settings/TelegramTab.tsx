import { AiPromptPanel } from '../modules/telegram/sections/AiPromptPanel';
import { ConnectionPanel } from '../modules/telegram/sections/ConnectionPanel';
import { MemoryPanel } from '../modules/telegram/sections/MemoryPanel';
import { NotificationsPanel } from '../modules/telegram/sections/NotificationsPanel';
import { SettingsSectionHeader } from './SettingsSectionHeader';

/// Settings host for everything Telegram-related *except* the inbox —
/// the inbox stays on its own top-level tab so it stays reachable from
/// the popup without two clicks. Each sub-panel returns raw rows so the
/// parent can stitch them together with the shared
/// `SettingsSectionHeader` + `divide-y divide-white/5` pattern used by
/// every other Settings tab.
export const TelegramTab = () => (
  <div className="max-w-[560px] mx-auto space-y-6">
    <section>
      <SettingsSectionHeader label="CONNECTION" />
      <div className="divide-y divide-white/5">
        <ConnectionPanel />
      </div>
    </section>

    <section>
      <SettingsSectionHeader label="NOTIFICATIONS" />
      <div className="divide-y divide-white/5">
        <NotificationsPanel />
      </div>
    </section>

    <section>
      <SettingsSectionHeader label="MEMORY" />
      <div className="divide-y divide-white/5">
        <MemoryPanel />
      </div>
    </section>

    <section>
      <SettingsSectionHeader label="AI PROMPT" />
      <div className="divide-y divide-white/5">
        <AiPromptPanel />
      </div>
    </section>
  </div>
);
