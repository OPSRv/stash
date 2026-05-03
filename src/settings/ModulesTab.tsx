import { useMemo } from 'react';
import { Button } from '../shared/ui/Button';
import { IconButton } from '../shared/ui/IconButton';
import { Toggle } from '../shared/ui/Toggle';
import { modules as ALL_MODULES } from '../modules/registry';
import { PROTECTED_MODULE_ID, resolveVisibleModules } from '../modules/visibility';
import { TAB_ICONS, TAB_ICON_COLORS } from '../shell/tabIcons';
import { SettingRow } from './SettingRow';
import { SettingsSection, SettingsTab } from './SettingsLayout';
import { DEFAULT_SETTINGS, type Settings } from './store';

interface ModulesTabProps {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const ChevronUp = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 15l6-6 6 6" />
  </svg>
);

const ChevronDown = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const buildOrder = (visible: { id: string }[]): string[] =>
  visible.filter((m) => m.id !== PROTECTED_MODULE_ID).map((m) => m.id);

export const ModulesTab = ({ settings, onChange }: ModulesTabProps) => {
  const visible = useMemo(
    () =>
      resolveVisibleModules(ALL_MODULES, {
        hiddenModules: settings.hiddenModules,
        moduleOrder: settings.moduleOrder,
      }),
    [settings.hiddenModules, settings.moduleOrder],
  );

  const hidden = useMemo(() => {
    const visibleIds = new Set(visible.map((m) => m.id));
    return ALL_MODULES.filter((m) => !visibleIds.has(m.id));
  }, [visible]);

  // Reorderable rows = everything except the pinned Settings row.
  const reorderable = visible.filter((m) => m.id !== PROTECTED_MODULE_ID);

  const setHidden = (id: string, isHidden: boolean) => {
    if (id === PROTECTED_MODULE_ID) return;
    const set = new Set(settings.hiddenModules);
    if (isHidden) set.add(id);
    else set.delete(id);
    onChange('hiddenModules', Array.from(set));
  };

  const move = (id: string, dir: -1 | 1) => {
    const idx = reorderable.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const target = idx + dir;
    if (target < 0 || target >= reorderable.length) return;
    const next = reorderable.slice();
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved);
    onChange('moduleOrder', buildOrder(next));
  };

  const reset = () => {
    onChange('hiddenModules', DEFAULT_SETTINGS.hiddenModules);
    onChange('moduleOrder', DEFAULT_SETTINGS.moduleOrder);
  };

  const isDirty =
    settings.hiddenModules.length > 0 || settings.moduleOrder.length > 0;

  return (
    <SettingsTab>
      <SettingsSection label="VISIBLE TABS" divided={false}>
        <p className="t-tertiary text-meta mb-2">
          Toggle a module off to hide its tab from the popup. Use the arrows
          to reorder. Settings is always pinned last.
        </p>
        <div
          className="rounded-lg hair border divide-y divide-white/5 [.light_&]:divide-black/5"
          role="list"
          aria-label="Visible tabs"
        >
          {visible.map((m) => {
            const isProtected = m.id === PROTECTED_MODULE_ID;
            const reorderIdx = reorderable.findIndex((r) => r.id === m.id);
            const canUp = !isProtected && reorderIdx > 0;
            const canDown = !isProtected && reorderIdx >= 0 && reorderIdx < reorderable.length - 1;
            return (
              <div
                key={m.id}
                role="listitem"
                className="flex items-center gap-2 px-2 py-1.5"
              >
                <span
                  className="inline-flex w-4 h-4 items-center justify-center shrink-0"
                  style={{ color: TAB_ICON_COLORS[m.id] ?? 'currentColor' }}
                  aria-hidden
                >
                  {TAB_ICONS[m.id]}
                </span>
                <span className="t-primary text-meta flex-1 truncate">{m.title}</span>
                {typeof m.tabShortcutDigit === 'number' && (
                  <span className="t-tertiary text-meta font-mono tabular-nums shrink-0">
                    ⌘⌥{m.tabShortcutDigit}
                  </span>
                )}
                <div className="flex items-center shrink-0">
                  <IconButton
                    onClick={() => move(m.id, -1)}
                    disabled={!canUp}
                    title={`Move ${m.title} up`}
                  >
                    <ChevronUp />
                  </IconButton>
                  <IconButton
                    onClick={() => move(m.id, 1)}
                    disabled={!canDown}
                    title={`Move ${m.title} down`}
                  >
                    <ChevronDown />
                  </IconButton>
                </div>
                <Toggle
                  checked
                  onChange={() => setHidden(m.id, true)}
                  label={
                    isProtected
                      ? `${m.title} cannot be hidden`
                      : `Hide ${m.title}`
                  }
                />
              </div>
            );
          })}
        </div>
      </SettingsSection>

      {hidden.length > 0 && (
        <SettingsSection label="HIDDEN" divided={false}>
          <div
            className="rounded-lg hair border divide-y divide-white/5 [.light_&]:divide-black/5"
            role="list"
            aria-label="Hidden tabs"
          >
            {hidden.map((m) => (
              <div
                key={m.id}
                role="listitem"
                className="flex items-center gap-2 px-2 py-1.5"
              >
                <span
                  className="inline-flex w-4 h-4 items-center justify-center shrink-0 opacity-60"
                  style={{ color: TAB_ICON_COLORS[m.id] ?? 'currentColor' }}
                  aria-hidden
                >
                  {TAB_ICONS[m.id]}
                </span>
                <span className="t-secondary text-meta flex-1 truncate">{m.title}</span>
                <Toggle
                  checked={false}
                  onChange={() => setHidden(m.id, false)}
                  label={`Show ${m.title}`}
                />
              </div>
            ))}
          </div>
        </SettingsSection>
      )}

      <SettingsSection label="DEFAULTS">
        <SettingRow
          title="Reset"
          description="Show every module and restore the original order."
          control={
            <Button size="sm" disabled={!isDirty} onClick={reset}>
              Reset
            </Button>
          }
        />
      </SettingsSection>
    </SettingsTab>
  );
};
