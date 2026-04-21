import { useState } from 'react';

import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { ConnectionPanel } from './sections/ConnectionPanel';
import { InboxPanel } from './sections/InboxPanel';
import { NotificationsPanel } from './sections/NotificationsPanel';

type SubTab = 'connection' | 'inbox' | 'notifications';

const OPTIONS = [
  { value: 'connection' as const, label: 'Connection' },
  { value: 'inbox' as const, label: 'Inbox' },
  { value: 'notifications' as const, label: 'Alerts' },
];

export function TelegramShell() {
  const [tab, setTab] = useState<SubTab>('connection');
  return (
    <div className="h-full overflow-auto flex flex-col">
      <div className="p-3 border-b border-white/5">
        <SegmentedControl<SubTab>
          options={OPTIONS}
          value={tab}
          onChange={setTab}
          ariaLabel="Telegram sub-tabs"
        />
      </div>
      {tab === 'connection' && <ConnectionPanel />}
      {tab === 'inbox' && <InboxPanel />}
      {tab === 'notifications' && <NotificationsPanel />}
    </div>
  );
}
