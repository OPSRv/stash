import { useCallback, useState } from 'react';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { useToast } from '../../shared/ui/Toast';
import {
  emptyMemoryPressure,
  flushDns,
  lockScreen,
  reindexSpotlight,
  sleepNow,
} from './api';

type Action = {
  id: string;
  label: string;
  hint: string;
  gradient: [string, string];
  glyph: string;
  run: () => Promise<void>;
  /// Destructive enough to warrant a confirm step before firing.
  confirm?: { title: string; description: string };
};

const ActionTile = ({ a, onRun }: { a: Action; onRun: (a: Action) => void }) => (
  <button
    type="button"
    onClick={() => onRun(a)}
    className="relative text-left rounded-2xl p-3 flex items-center gap-3 ring-focus transition-transform hover:scale-[1.01] active:scale-[0.995]"
    style={{
      background: `linear-gradient(135deg, ${a.gradient[0]}22, ${a.gradient[1]}33)`,
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
    }}
  >
    <div
      aria-hidden
      className="absolute -top-6 -right-6 w-20 h-20 rounded-full"
      style={{
        background: `radial-gradient(closest-side, ${a.gradient[1]}55, transparent)`,
        filter: 'blur(6px)',
      }}
    />
    <div
      aria-hidden
      className="relative shrink-0 w-10 h-10 rounded-xl inline-flex items-center justify-center"
      style={{
        background: `linear-gradient(135deg, ${a.gradient[0]}, ${a.gradient[1]})`,
        boxShadow: `0 6px 18px -6px ${a.gradient[1]}, inset 0 0 0 1px rgba(255,255,255,0.2)`,
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={a.glyph} />
      </svg>
    </div>
    <div className="relative min-w-0 flex-1">
      <div className="t-primary text-body font-semibold truncate">{a.label}</div>
      <div className="t-tertiary text-meta truncate">{a.hint}</div>
    </div>
  </button>
);

export const QuickActionsPanel = () => {
  const { toast } = useToast();
  const [confirmFor, setConfirmFor] = useState<Action | null>(null);

  const execute = useCallback(
    async (a: Action) => {
      setConfirmFor(null);
      try {
        await a.run();
        toast({ title: a.label, description: 'Виконано', variant: 'success' });
      } catch (e) {
        toast({ title: a.label, description: String(e), variant: 'error' });
      }
    },
    [toast],
  );

  const onRun = useCallback(
    (a: Action) => {
      if (a.confirm) setConfirmFor(a);
      else execute(a);
    },
    [execute],
  );

  const actions: Action[] = [
    {
      id: 'sleep',
      label: 'Приспати Mac',
      hint: 'pmset sleepnow',
      gradient: ['#8ec5ff', '#5561ff'],
      glyph: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
      run: sleepNow,
    },
    {
      id: 'lock',
      label: 'Заблокувати екран',
      hint: 'CGSession -suspend',
      gradient: ['#d08cff', '#7a4bff'],
      glyph: 'M12 11V7a3 3 0 1 1 6 0v4M8 11h12v10H8z',
      run: lockScreen,
    },
    {
      id: 'purge',
      label: 'Звільнити RAM (purge)',
      hint: 'Запитає пароль адміністратора',
      gradient: ['#7ef7a5', '#17b26a'],
      glyph: 'M5 12a7 7 0 1 1 14 0M5 12l-2 2M19 12l2 2M12 5V3',
      run: emptyMemoryPressure,
      confirm: {
        title: 'Звільнити неактивну RAM?',
        description:
          'macOS покаже стандартне вікно авторизації — введіть пароль адміністратора, і команда `purge` виконається.',
      },
    },
    {
      id: 'dns',
      label: 'Очистити DNS-кеш',
      hint: 'dscacheutil + mDNSResponder',
      gradient: ['#5ee2c4', '#2aa3ff'],
      glyph: 'M4 12h16M12 4v16M6 6l12 12M18 6L6 18',
      run: flushDns,
    },
    {
      id: 'spotlight',
      label: 'Переіндексувати Spotlight',
      hint: 'mdutil -E /',
      gradient: ['#ffd86b', '#ff914d'],
      glyph: 'M11 3a8 8 0 1 1-5.66 13.66l-3 3M11 3a8 8 0 0 1 8 8',
      run: reindexSpotlight,
      confirm: {
        title: 'Переіндексувати Spotlight?',
        description:
          'Spotlight перебудує індекс на томі «/» у фоні. Пошук може лагати декілька хвилин.',
      },
    },
  ];

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <header>
        <div className="t-primary text-title font-semibold">Швидкі дії</div>
        <div className="t-tertiary text-meta">
          Системні команди одним кліком — з підтвердженням для небезпечних.
        </div>
      </header>

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
      >
        {actions.map((a) => (
          <ActionTile key={a.id} a={a} onRun={onRun} />
        ))}
      </div>

      <ConfirmDialog
        open={confirmFor !== null}
        title={confirmFor?.confirm?.title ?? ''}
        description={confirmFor?.confirm?.description}
        confirmLabel="Виконати"
        tone="danger"
        onConfirm={() => confirmFor && execute(confirmFor)}
        onCancel={() => setConfirmFor(null)}
      />
    </div>
  );
};
