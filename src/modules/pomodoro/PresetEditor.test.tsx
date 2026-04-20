import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { PresetEditor } from './PresetEditor';

describe('PresetEditor', () => {
  it('adds a default block when "Add block" is clicked', async () => {
    const user = userEvent.setup();
    render(
      <PresetEditor
        initial={null}
        onSave={() => {}}
        onStartWithoutSaving={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getAllByLabelText('Block name')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /add block/i }));
    expect(screen.getAllByLabelText('Block name')).toHaveLength(2);
  });

  it('Save is disabled until name is provided', () => {
    render(
      <PresetEditor
        initial={null}
        onSave={() => {}}
        onStartWithoutSaving={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /save preset/i })).toBeDisabled();
  });

  it('Save calls onSave with trimmed name, kind and current blocks', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <PresetEditor
        initial={null}
        onSave={onSave}
        onStartWithoutSaving={() => {}}
        onCancel={() => {}}
      />,
    );
    await user.type(screen.getByLabelText('Preset name'), '  Daily  ');
    await user.click(screen.getByRole('button', { name: /save preset/i }));
    expect(onSave).toHaveBeenCalledWith(
      'Daily',
      'session',
      expect.arrayContaining([expect.objectContaining({ name: 'Focus' })]),
    );
  });

  it('Kind segmented control switches preset flavor', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <PresetEditor
        initial={null}
        onSave={onSave}
        onStartWithoutSaving={() => {}}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByRole('radio', { name: /daily/i }));
    await user.type(screen.getByLabelText('Preset name'), 'Plan');
    await user.click(screen.getByRole('button', { name: /save preset/i }));
    expect(onSave).toHaveBeenCalledWith('Plan', 'daily', expect.anything());
  });

  it('Start without saving bypasses the preset-name requirement', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(
      <PresetEditor
        initial={null}
        onSave={() => {}}
        onStartWithoutSaving={onStart}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /start without saving/i }));
    expect(onStart).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ posture: 'sit' })]),
    );
  });

  it('cannot delete the last remaining block', async () => {
    const user = userEvent.setup();
    render(
      <PresetEditor
        initial={null}
        onSave={() => {}}
        onStartWithoutSaving={() => {}}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /remove block/i }));
    expect(screen.getAllByLabelText('Block name')).toHaveLength(1);
  });
});
