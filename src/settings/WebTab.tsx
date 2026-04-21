import { Button } from '../shared/ui/Button';
import { Input } from '../shared/ui/Input';

import { SettingRow } from './SettingRow';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import type { Settings, WebChatService } from './store';

interface WebTabProps {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

// Derive a safe id from a human label — matches the Rust-side `label_for()`
// validator (`[a-zA-Z0-9_-]+`). Kept local to Settings; the popup's own add
// dialog has its own slugify in modules/web/webServiceUtils.
const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'service';

const freshServiceId = (existing: WebChatService[]): string => {
  const base = 'service';
  const used = new Set(existing.map((s) => s.id));
  let i = 1;
  while (used.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
};

const updateService = (
  settings: Settings,
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void,
  index: number,
  patch: Partial<WebChatService>,
) => {
  const next = settings.aiWebServices.map((s, i) => {
    if (i !== index) return s;
    const merged = { ...s, ...patch };
    if (patch.label !== undefined) {
      merged.id = slugify(patch.label);
    }
    return merged;
  });
  onChange('aiWebServices', next);
};

const moveService = (
  settings: Settings,
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void,
  from: number,
  to: number,
) => {
  if (to < 0 || to >= settings.aiWebServices.length) return;
  const next = settings.aiWebServices.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  onChange('aiWebServices', next);
};

export const WebTab = ({ settings, onChange }: WebTabProps) => {
  return (
    <div className="max-w-[560px] mx-auto space-y-6">
      <section>
        <SettingsSectionHeader label="TABS" />
        <div className="divide-y divide-white/5">
          <SettingRow
            title="Saved tabs"
            description="Shown in the Web tab's tab bar. Each opens as a native child webview so your regular browser login carries over."
            control={
              <Button
                size="sm"
                variant="soft"
                shape="square"
                aria-label="Add tab"
                title="Add tab"
                onClick={() => {
                  const nextId = freshServiceId(settings.aiWebServices);
                  onChange('aiWebServices', [
                    ...settings.aiWebServices,
                    { id: nextId, label: 'New tab', url: 'https://' },
                  ]);
                }}
              >
                +
              </Button>
            }
          />
          <div className="py-1 space-y-1.5">
            {settings.aiWebServices.map((s, i) => (
              <div key={s.id + i} className="flex items-center gap-2">
                <Input
                  aria-label="Tab label"
                  placeholder="Label"
                  value={s.label}
                  onChange={(e) =>
                    updateService(settings, onChange, i, { label: e.currentTarget.value })
                  }
                  className="w-[140px]"
                />
                <Input
                  aria-label="Tab URL"
                  placeholder="https://"
                  value={s.url}
                  onChange={(e) =>
                    updateService(settings, onChange, i, { url: e.currentTarget.value })
                  }
                  className="flex-1"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  shape="square"
                  disabled={i === 0}
                  onClick={() => moveService(settings, onChange, i, i - 1)}
                  aria-label="Move up"
                  title="Move up"
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  shape="square"
                  disabled={i === settings.aiWebServices.length - 1}
                  onClick={() => moveService(settings, onChange, i, i + 1)}
                  aria-label="Move down"
                  title="Move down"
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  tone="danger"
                  onClick={() =>
                    onChange(
                      'aiWebServices',
                      settings.aiWebServices.filter((_, j) => j !== i),
                    )
                  }
                  aria-label="Remove tab"
                  title="Remove"
                >
                  ×
                </Button>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};
