import { useState } from 'react';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { ProcessesPanel } from './ProcessesPanel';
import { DisplaysPanel } from './DisplaysPanel';

type Tab = 'processes' | 'displays';

export const SystemShell = () => {
  const [tab, setTab] = useState<Tab>('processes');
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b hair">
        <div className="t-primary text-body font-semibold">Система</div>
        <SegmentedControl<Tab>
          size="sm"
          value={tab}
          onChange={setTab}
          ariaLabel="Підрозділи системного модуля"
          options={[
            { value: 'processes', label: 'Процеси' },
            { value: 'displays', label: 'Екрани' },
          ]}
        />
      </div>
      {tab === 'processes' ? <ProcessesPanel /> : <DisplaysPanel />}
    </div>
  );
};
