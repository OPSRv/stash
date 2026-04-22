import { useState } from 'react';

import { AiPromptPanel } from '../modules/telegram/sections/AiPromptPanel';
import { ConnectionPanel } from '../modules/telegram/sections/ConnectionPanel';
import { MemoryPanel } from '../modules/telegram/sections/MemoryPanel';
import { NotificationsPanel } from '../modules/telegram/sections/NotificationsPanel';
import { SegmentedControl } from '../shared/ui/SegmentedControl';

type Section = 'connection' | 'notifications' | 'memory' | 'prompt';

const OPTIONS = [
  { value: 'connection' as const, label: 'Connection' },
  { value: 'notifications' as const, label: 'Alerts' },
  { value: 'memory' as const, label: 'Memory' },
  { value: 'prompt' as const, label: 'AI Prompt' },
];

/// Settings host for everything Telegram-related *except* the inbox —
/// the inbox stays on its own top-level tab so it stays reachable from
/// the popup without two clicks. Sub-sections keep their existing
/// components; this file just wires them under a segmented control.
export const TelegramTab = () => {
  const [section, setSection] = useState<Section>('connection');
  return (
    <div className="max-w-[560px] mx-auto">
      <div className="mb-5">
        <SegmentedControl<Section>
          options={OPTIONS}
          value={section}
          onChange={setSection}
          ariaLabel="Telegram settings sections"
        />
      </div>
      {section === 'connection' && <ConnectionPanel />}
      {section === 'notifications' && <NotificationsPanel />}
      {section === 'memory' && <MemoryPanel />}
      {section === 'prompt' && <AiPromptPanel />}
    </div>
  );
};
