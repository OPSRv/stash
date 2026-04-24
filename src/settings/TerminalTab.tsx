import { Button } from '../shared/ui/Button';
import { Input } from '../shared/ui/Input';
import { SettingRow } from './SettingRow';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import type { Settings, TerminalSnippet } from './store';

interface TerminalTabProps {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const freshId = (existing: TerminalSnippet[]): string => {
  const used = new Set(existing.map((s) => s.id));
  let i = 1;
  while (used.has(`snippet-${i}`)) i += 1;
  return `snippet-${i}`;
};

const updateSnippet = (
  settings: Settings,
  onChange: TerminalTabProps['onChange'],
  index: number,
  patch: Partial<TerminalSnippet>,
) => {
  const next = settings.terminalSnippets.map((s, i) =>
    i === index ? { ...s, ...patch } : s,
  );
  onChange('terminalSnippets', next);
};

export const TerminalTab = ({ settings, onChange }: TerminalTabProps) => (
  <div className="max-w-[560px] mx-auto space-y-6">
    <section>
      <SettingsSectionHeader label="CLAUDE CODE" />
      <div className="divide-y divide-white/5">
        <SettingRow
          title="Launcher command"
          description="Runs when the Claude Code button in the terminal header is clicked. Add flags to taste — the whole line is written into the PTY verbatim, followed by Enter."
          control={
            <Input
              size="sm"
              aria-label="Claude Code launcher command"
              placeholder="claude"
              value={settings.terminalClaudeCommand}
              onChange={(e) =>
                onChange('terminalClaudeCommand', e.currentTarget.value)
              }
              className="w-[260px] font-mono"
            />
          }
        />
      </div>
    </section>
    <section>
      <SettingsSectionHeader label="SNIPPETS" />
      <div className="divide-y divide-white/5">
        <SettingRow
          title="Command snippets"
          description="Each snippet becomes a button in the Terminal tab. Clicking it writes the command followed by a newline into the active shell."
          control={
            <Button
              size="sm"
              variant="soft"
              shape="square"
              aria-label="Add snippet"
              title="Add snippet"
              onClick={() =>
                onChange('terminalSnippets', [
                  ...settings.terminalSnippets,
                  { id: freshId(settings.terminalSnippets), label: 'New', command: '' },
                ])
              }
            >
              +
            </Button>
          }
        />
      </div>
      <div className="py-2 space-y-1.5">
      {settings.terminalSnippets.length === 0 && (
        <div className="t-tertiary text-meta italic">
          No snippets yet — add one above to get a dedicated button in the Terminal tab.
        </div>
      )}
      {settings.terminalSnippets.map((s, i) => (
        <div key={s.id + i} className="flex items-center gap-2">
          <Input
            size="sm"
            aria-label="Snippet label"
            placeholder="Label"
            value={s.label}
            onChange={(e) =>
              updateSnippet(settings, onChange, i, { label: e.currentTarget.value })
            }
            className="w-[140px]"
          />
          <Input
            size="sm"
            aria-label="Snippet command"
            placeholder="claude --model opus"
            value={s.command}
            onChange={(e) =>
              updateSnippet(settings, onChange, i, { command: e.currentTarget.value })
            }
            className="flex-1 font-mono"
          />
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            onClick={() =>
              onChange(
                'terminalSnippets',
                settings.terminalSnippets.filter((_, j) => j !== i),
              )
            }
            aria-label="Remove snippet"
            title="Remove"
          >
            ×
          </Button>
        </div>
      ))}
      </div>
    </section>
  </div>
);
