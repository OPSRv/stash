import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '../shared/ui/Button';
import { ConfirmDialog } from '../shared/ui/ConfirmDialog';
import { Toggle } from '../shared/ui/Toggle';
import { useToast } from '../shared/ui/Toast';
import { SettingRow } from './SettingRow';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import {
  describeBackup,
  exportBackup,
  importBackup,
  inspectBackup,
  suggestFilename,
  type InspectReport,
  type ModuleDescription,
} from './backupApi';

/// Temporarily suppress popup auto-hide while a native save/open dialog
/// is on screen — otherwise clicking the dialog blurs the popup and
/// hides it (which on macOS also dismisses the dialog).
const withAutoHideSuspended = async <T,>(fn: () => Promise<T>): Promise<T> => {
  await invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
  try {
    return await fn();
  } finally {
    await invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
  }
};

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

export const BackupSection = () => {
  const { toast } = useToast();
  const [modules, setModules] = useState<ModuleDescription[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeMedia, setIncludeMedia] = useState(true);
  const [busy, setBusy] = useState(false);
  const [importPreview, setImportPreview] = useState<
    { path: string; report: InspectReport } | null
  >(null);

  useEffect(() => {
    describeBackup()
      .then((ms) => {
        const list = ms ?? [];
        setModules(list);
        setSelected(new Set(list.filter((m) => m.available).map((m) => m.id)));
      })
      .catch((e) => {
        console.error('describe failed', e);
        toast({
          title: 'Backup unavailable',
          description: String(e),
          variant: 'error',
        });
      });
  }, [toast]);

  const totalBytes = useMemo(
    () =>
      modules
        .filter((m) => selected.has(m.id))
        .reduce((acc, m) => acc + m.size_bytes, 0),
    [modules, selected],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAll = () => setSelected(new Set(modules.map((m) => m.id)));
  const selectNone = () => setSelected(new Set());

  const onExport = async () => {
    if (selected.size === 0) {
      toast({ title: 'Nothing selected' });
      return;
    }
    const filename = await suggestFilename().catch(() => 'stash-backup.zip');
    const chosen = await withAutoHideSuspended(() =>
      saveDialog({ defaultPath: filename, filters: [{ name: 'Zip', extensions: ['zip'] }] }),
    );
    if (typeof chosen !== 'string') return;
    setBusy(true);
    try {
      const rep = await exportBackup(chosen, {
        modules: [...selected],
        include_media: includeMedia,
        include_settings: selected.has('settings'),
      });
      toast({
        title: 'Backup saved',
        description: `${rep.modules.length} modules · ${formatBytes(rep.size_bytes)}`,
        variant: 'success',
      });
    } catch (e) {
      toast({ title: 'Export failed', description: String(e), variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const onImportPick = async () => {
    const picked = await withAutoHideSuspended(() =>
      openDialog({ multiple: false, filters: [{ name: 'Zip', extensions: ['zip'] }] }),
    );
    if (typeof picked !== 'string') return;
    try {
      const report = await inspectBackup(picked);
      setImportPreview({ path: picked, report });
    } catch (e) {
      toast({
        title: 'Invalid backup',
        description: String(e),
        variant: 'error',
      });
    }
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    const { path, report } = importPreview;
    setImportPreview(null);
    setBusy(true);
    try {
      await importBackup(path, {
        modules: Object.keys(report.manifest.modules),
        include_media: report.manifest.include_media,
        include_settings: report.manifest.include_settings,
      });
      toast({
        title: 'Restarting to finish import…',
        variant: 'success',
      });
    } catch (e) {
      toast({ title: 'Import failed', description: String(e), variant: 'error' });
      setBusy(false);
    }
  };

  return (
    <section>
      <SettingsSectionHeader label="BACKUP" />
      <div className="space-y-4">
        <div className="rounded-md hair border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="screen-label">INCLUDE</div>
            <div className="flex gap-1.5">
              <Button size="xs" variant="ghost" onClick={selectAll}>
                All
              </Button>
              <Button size="xs" variant="ghost" onClick={selectNone}>
                None
              </Button>
            </div>
          </div>
          <ul className="space-y-1.5">
            {modules.map((m) => (
              <li key={m.id} className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id={`backup-${m.id}`}
                  checked={selected.has(m.id)}
                  disabled={!m.available}
                  onChange={() => toggle(m.id)}
                  className="accent-[rgba(var(--stash-accent-rgb),1)]"
                />
                <label htmlFor={`backup-${m.id}`} className="flex-1 min-w-0 cursor-pointer">
                  <div className="t-primary text-body">{m.label}</div>
                  <div className="t-tertiary text-meta">{m.summary}</div>
                </label>
                <div className="t-tertiary text-meta shrink-0">
                  {m.size_bytes > 0 ? formatBytes(m.size_bytes) : '—'}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <SettingRow
          title="Include media files"
          description="Clipboard images, note audio and images. Increases archive size."
          control={<Toggle checked={includeMedia} onChange={setIncludeMedia} label="Include media files" />}
        />

        <div className="flex items-center justify-between gap-3">
          <div className="t-tertiary text-meta">
            Estimated size: {formatBytes(totalBytes)}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onImportPick} disabled={busy}>
              Import backup…
            </Button>
            <Button tone="accent" onClick={onExport} loading={busy}>
              Export backup…
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={importPreview !== null}
        title="Restore from backup?"
        description={
          importPreview
            ? `The app will restart to apply the backup. Modules in the archive will replace current data: ${Object.keys(importPreview.report.manifest.modules).join(', ') || '—'}.${
                importPreview.report.unknown_modules.length
                  ? ` Unknown modules will be skipped: ${importPreview.report.unknown_modules.join(', ')}.`
                  : ''
              }`
            : ''
        }
        confirmLabel="Import & Restart"
        cancelLabel="Cancel"
        tone="danger"
        onConfirm={confirmImport}
        onCancel={() => setImportPreview(null)}
      />
    </section>
  );
};
