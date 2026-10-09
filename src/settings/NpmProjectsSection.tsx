import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '../shared/ui/Button';
import { IconButton } from '../shared/ui/IconButton';
import { Input } from '../shared/ui/Input';
import { CloseIcon } from '../shared/ui/icons';
import { SettingRow } from './SettingRow';
import { SettingsSection } from './SettingsLayout';
import { npmReadProject, type NpmProjectInfo } from './npmScriptsApi';
import type { Settings } from './store';

interface NpmProjectsSectionProps {
  projects: string[];
  onChange: (next: Settings['npmProjects']) => void;
}

type ProjectStatus = NpmProjectInfo | { error: string };

const folderName = (path: string) =>
  path.replace(/\/+$/, '').split('/').pop() || path;

/// Settings → Terminal → NPM SCRIPTS. Manages the project folders whose
/// package.json scripts appear as submenus in the tray context menu.
export const NpmProjectsSection = ({ projects, onChange }: NpmProjectsSectionProps) => {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Record<string, ProjectStatus>>({});

  // Re-read every configured package.json so names / script counts stay
  // fresh (and a moved folder shows its error inline).
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      projects.map((p) =>
        npmReadProject(p).then(
          (info): [string, ProjectStatus] => [p, info],
          (e): [string, ProjectStatus] => [p, { error: String(e) }],
        ),
      ),
    ).then((entries) => {
      if (!cancelled) setStatus(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [projects]);

  const add = async (raw: string) => {
    const path = raw.trim().replace(/(.)\/+$/, '$1');
    if (!path) return;
    if (projects.includes(path)) {
      setError('This folder is already in the list.');
      return;
    }
    setBusy(true);
    try {
      const info = await npmReadProject(path);
      setError(null);
      setDraft('');
      setStatus((s) => ({ ...s, [info.path]: info }));
      onChange([...projects, info.path]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickFolder = async () => {
    // Popup hides on blur; suspend that while the native modal is up so
    // taking focus for the folder picker does not dismiss it.
    await invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === 'string') await add(selected);
    } catch (e) {
      console.error('folder pick failed', e);
    } finally {
      await invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
    }
  };

  return (
    <SettingsSection label="NPM SCRIPTS" divided={false}>
      <SettingRow
        title="Project folders"
        description="Each folder's package.json scripts appear as a submenu in the tray menu. Picking one opens a new Terminal tab in that folder and runs it."
        control={null}
      />
      <div className="flex items-center gap-2 pb-2">
        <Input
          size="sm"
          aria-label="Project folder path"
          placeholder="/Users/me/projects/my-app"
          value={draft}
          invalid={error != null}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add(draft);
            }
          }}
          className="flex-1 font-mono"
        />
        <Button size="sm" onClick={() => void add(draft)} disabled={busy || !draft.trim()}>
          Add
        </Button>
        <Button size="sm" variant="soft" onClick={pickFolder} disabled={busy}>
          Choose…
        </Button>
      </div>
      {error && (
        <div className="t-danger text-meta pb-2" role="alert">
          {error}
        </div>
      )}
      <div className="py-1 space-y-1.5">
        {projects.length === 0 && (
          <div className="t-tertiary text-meta italic">
            No projects yet — add a folder that contains a package.json.
          </div>
        )}
        {projects.map((path) => {
          const st = status[path];
          const name = st && 'name' in st ? st.name : folderName(path);
          return (
            <div key={path} className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="t-primary text-body font-medium truncate">{name}</div>
                <div className="t-tertiary text-meta font-mono truncate">{path}</div>
              </div>
              <div className="shrink-0 text-meta">
                {!st ? null : 'error' in st ? (
                  <span className="t-danger">{st.error}</span>
                ) : (
                  <span className="t-secondary">
                    {st.scripts.length} {st.scripts.length === 1 ? 'script' : 'scripts'}
                  </span>
                )}
              </div>
              <IconButton
                title="Remove"
                tone="danger"
                onClick={() => onChange(projects.filter((p) => p !== path))}
              >
                <CloseIcon />
              </IconButton>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
};
