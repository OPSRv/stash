import { useEffect, useMemo, useRef, useState } from 'react';
import { ProcessesPanel } from './ProcessesPanel';
import { Badge } from '../../shared/ui/Badge';
import { Input } from '../../shared/ui/Input';
import { SmartScanPanel } from './SmartScanPanel';
import { DockerPanel } from './DockerPanel';
import { DisplaysPanel } from './DisplaysPanel';
import { LargeFilesPanel } from './LargeFilesPanel';
import { CachesPanel } from './CachesPanel';
import { LaunchAgentsPanel } from './LaunchAgentsPanel';
import { UninstallerPanel } from './UninstallerPanel';
import { DashboardPanel } from './DashboardPanel';
import { TrashBinsPanel } from './TrashBinsPanel';
import { NodeModulesPanel } from './NodeModulesPanel';
import { DiskHogsPanel } from './DiskHogsPanel';
import { DuplicatesPanel } from './DuplicatesPanel';
import { BatteryPanel } from './BatteryPanel';
import { QuickActionsPanel } from './QuickActionsPanel';
import { PrivacyPanel } from './PrivacyPanel';
import { NetworkPanel } from './NetworkPanel';
import { PlaceholderPanel } from './PlaceholderPanel';

type Tab =
  | 'dashboard'
  | 'smart-scan'
  | 'processes'
  | 'network'
  | 'displays'
  | 'battery'
  | 'quick-actions'
  | 'large-files'
  | 'node-modules'
  | 'caches'
  | 'docker'
  | 'trash-bins'
  | 'disk-hogs'
  | 'duplicates'
  | 'uninstaller'
  | 'launch-agents'
  | 'privacy';

type NavItem = {
  id: Tab;
  label: string;
  hint: string;
  gradient: [string, string];
  glyph: string;
  implemented: boolean;
  group: 'overview' | 'storage' | 'system' | 'security';
};

const NAV: NavItem[] = [
  // Overview
  {
    id: 'dashboard',
    label: 'Огляд',
    hint: 'CPU, RAM, диск, батарея',
    gradient: ['#ff8a5b', '#ff3a6f'],
    glyph: 'M3 13h4l3-8 4 14 3-6h4',
    implemented: true,
    group: 'overview',
  },
  {
    id: 'smart-scan',
    label: 'Розумне прибирання',
    hint: 'Один клік — усе гамузом',
    gradient: ['#ffd86b', '#ff3a6f'],
    glyph: 'M13 2 4 14h7l-1 8 9-12h-7z',
    implemented: true,
    group: 'overview',
  },
  {
    id: 'processes',
    label: 'Процеси',
    hint: 'Важкі задачі, RAM, CPU',
    gradient: ['#ff8a5b', '#ff3a6f'],
    glyph: 'M3 4h18v4H3zM3 10h18v4H3zM3 16h18v4H3z',
    implemented: true,
    group: 'overview',
  },
  {
    id: 'network',
    label: 'Мережа',
    hint: 'Активні зʼєднання',
    gradient: ['#5ee2c4', '#2aa3ff'],
    glyph: 'M5 12a14 14 0 0 1 14 0M3 8a20 20 0 0 1 18 0M7 16a8 8 0 0 1 10 0',
    implemented: true,
    group: 'overview',
  },
  {
    id: 'displays',
    label: 'Екрани',
    hint: 'Яскравість, сон моніторів',
    gradient: ['#8ec5ff', '#5561ff'],
    glyph: 'M3 4h18v12H3zM8 20h8M12 16v4',
    implemented: true,
    group: 'overview',
  },
  {
    id: 'battery',
    label: 'Батарея',
    hint: 'Цикли, стан, ємність',
    gradient: ['#7ef7a5', '#17b26a'],
    glyph: 'M3 8h14v8H3zM17 10h2v4h-2zM6 11h6',
    implemented: true,
    group: 'overview',
  },
  {
    id: 'quick-actions',
    label: 'Швидкі дії',
    hint: 'Sleep, Lock, DNS, Spotlight',
    gradient: ['#ffd86b', '#ff914d'],
    glyph: 'M13 2 4 14h7l-1 8 9-12h-7z',
    implemented: true,
    group: 'overview',
  },

  // Storage
  {
    id: 'large-files',
    label: 'Великі файли',
    hint: 'Знайди й видали важке',
    gradient: ['#ffd86b', '#ff914d'],
    glyph: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
    implemented: true,
    group: 'storage',
  },
  {
    id: 'node-modules',
    label: 'node_modules',
    hint: 'Рекурсивно у вибраній папці',
    gradient: ['#5ee2c4', '#17b26a'],
    glyph: 'M3 7l9-4 9 4v10l-9 4-9-4z',
    implemented: true,
    group: 'storage',
  },
  {
    id: 'caches',
    label: 'Кеші',
    hint: 'Браузери, npm, Xcode',
    gradient: ['#5ee2c4', '#2aa3ff'],
    glyph: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18',
    implemented: true,
    group: 'storage',
  },
  {
    id: 'docker',
    label: 'Docker',
    hint: 'Images, volumes, cache',
    gradient: ['#0ea5e9', '#5ee2c4'],
    glyph: 'M3 7h4v4H3zM8 7h4v4H8zM13 7h4v4h-4zM8 3h4v4H8zM2 14h20c0 3-3 6-10 6-6 0-10-3-10-6z',
    implemented: true,
    group: 'storage',
  },
  {
    id: 'trash-bins',
    label: 'Кошики',
    hint: 'Усі томи · Empty all',
    gradient: ['#ff8a5b', '#ff3a6f'],
    glyph: 'M3 6h18M8 6l1-3h6l1 3M6 6l1 14h10l1-14',
    implemented: true,
    group: 'storage',
  },
  {
    id: 'disk-hogs',
    label: 'Важке на диску',
    hint: 'iOS, Mail, Xcode, TM',
    gradient: ['#ffd86b', '#ff3a6f'],
    glyph: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2',
    implemented: true,
    group: 'storage',
  },
  {
    id: 'duplicates',
    label: 'Дублікати',
    hint: 'SHA-256 + розмір',
    gradient: ['#d08cff', '#5561ff'],
    glyph: 'M4 4h12v12H4zM8 8h12v12H8z',
    implemented: true,
    group: 'storage',
  },

  // System
  {
    id: 'uninstaller',
    label: 'Деінсталятор',
    hint: 'Застосунки + залишки',
    gradient: ['#d08cff', '#7a4bff'],
    glyph: 'M9 7V4h6v3M5 7h14l-1 13H6z',
    implemented: true,
    group: 'system',
  },
  {
    id: 'launch-agents',
    label: 'Автозапуск',
    hint: 'LaunchAgents',
    gradient: ['#7ef7a5', '#17b26a'],
    glyph: 'M12 2v6M12 22v-4M4 12H2M22 12h-2M5 5l1.5 1.5M19 19l-1.5-1.5M5 19l1.5-1.5M19 5l-1.5 1.5',
    implemented: true,
    group: 'system',
  },

  // Security
  {
    id: 'privacy',
    label: 'Приватність',
    hint: 'Історія, recents, QuickLook',
    gradient: ['#d08cff', '#ff3a6f'],
    glyph: 'M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z',
    implemented: true,
    group: 'security',
  },
];

const GROUP_LABEL: Record<NavItem['group'], string> = {
  overview: 'Огляд',
  storage: 'Диск',
  system: 'Система',
  security: 'Приватність',
};

const NavTile = ({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className={`group relative w-full text-left rounded-xl px-2 py-1.5 flex items-center gap-2 transition-all duration-150 ring-focus ${
      active
        ? 'bg-white/[0.08] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]'
        : 'hover:bg-white/[0.04]'
    }`}
  >
    <span
      aria-hidden
      className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-lg relative"
      style={{
        background: `linear-gradient(135deg, ${item.gradient[0]}, ${item.gradient[1]})`,
        boxShadow: active
          ? `0 6px 18px -6px ${item.gradient[1]}, inset 0 0 0 1px rgba(255,255,255,0.2)`
          : `0 4px 12px -6px ${item.gradient[1]}80, inset 0 0 0 1px rgba(255,255,255,0.14)`,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={item.glyph} />
      </svg>
    </span>
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5">
        <span className="t-primary text-body font-medium truncate">{item.label}</span>
        {!item.implemented && (
          <Badge tone="neutral" className="uppercase tracking-wider">soon</Badge>
        )}
      </span>
      <span className="block t-tertiary text-[11px] truncate">{item.hint}</span>
    </span>
  </button>
);

export const SystemShell = () => {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const active = NAV.find((n) => n.id === tab) ?? NAV[0];

  // Cmd+F anywhere in this tab focuses the sidebar filter. We handle
  // the shortcut locally — when the popup shell captures keyboard events
  // it doesn't forward them to us, and this way the behaviour survives
  // even inside scrolling panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setQuery('');
        searchRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filteredIds = useMemo<Set<Tab> | null>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      NAV.filter(
        (n) =>
          n.label.toLowerCase().includes(q) || n.hint.toLowerCase().includes(q),
      ).map((n) => n.id),
    );
  }, [query]);

  const body = (() => {
    switch (tab) {
      case 'dashboard':
        return <DashboardPanel />;
      case 'smart-scan':
        return <SmartScanPanel />;
      case 'docker':
        return <DockerPanel />;
      case 'processes':
        return <ProcessesPanel />;
      case 'network':
        return <NetworkPanel />;
      case 'displays':
        return <DisplaysPanel />;
      case 'battery':
        return <BatteryPanel />;
      case 'quick-actions':
        return <QuickActionsPanel />;
      case 'large-files':
        return <LargeFilesPanel />;
      case 'node-modules':
        return <NodeModulesPanel />;
      case 'caches':
        return <CachesPanel />;
      case 'trash-bins':
        return <TrashBinsPanel />;
      case 'disk-hogs':
        return <DiskHogsPanel />;
      case 'duplicates':
        return <DuplicatesPanel />;
      case 'uninstaller':
        return <UninstallerPanel />;
      case 'launch-agents':
        return <LaunchAgentsPanel />;
      case 'privacy':
        return <PrivacyPanel />;
      default:
        return <PlaceholderPanel item={active} />;
    }
  })();

  const groups: NavItem['group'][] = ['overview', 'storage', 'system', 'security'];

  return (
    <div className="flex h-full min-h-0">
      <aside
        className="w-[176px] shrink-0 border-r hair flex flex-col"
        aria-label="Підрозділи системного модуля"
      >
        <div className="px-2 pt-2 pb-1">
          <Input
            ref={searchRef}
            type="search"
            role="searchbox"
            size="sm"
            placeholder="⌘F пошук…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
          {groups.map((g) => {
            const items = NAV.filter((n) => n.group === g).filter(
              (n) => !filteredIds || filteredIds.has(n.id),
            );
            if (items.length === 0) return null;
            return (
              <div key={g} className="mb-2">
                <div className="px-2 py-1 t-tertiary text-[10px] uppercase tracking-wider">
                  {GROUP_LABEL[g]}
                </div>
                <div className="flex flex-col gap-0.5">
                  {items.map((item) => (
                    <NavTile
                      key={item.id}
                      item={item}
                      active={item.id === tab}
                      onClick={() => setTab(item.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {filteredIds && filteredIds.size === 0 && (
            <div className="px-2 py-3 t-tertiary text-meta">
              Нічого не знайдено
            </div>
          )}
        </div>
      </aside>
      <section className="flex-1 min-w-0 flex flex-col">{body}</section>
    </div>
  );
};

export type { NavItem };
