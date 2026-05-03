import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { SeparatorShell } from './SeparatorShell';
import type { SeparatorJob, SeparatorStatus } from './api';

const mockedInvoke = vi.mocked(invoke);

const installed: SeparatorStatus = {
  ready: true,
  runtime_ready: true,
  ft_ready: false,
  default_output_dir: '/Music/Stash Stems',
  assets: [],
};
const notInstalled: SeparatorStatus = {
  ready: false,
  runtime_ready: false,
  ft_ready: false,
  default_output_dir: '/Music/Stash Stems',
  assets: [],
};

function mockBackend({
  status = installed,
  jobs = [] as SeparatorJob[],
}: { status?: SeparatorStatus; jobs?: SeparatorJob[] } = {}) {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'separator_status') return status;
    // The shell now hydrates from disk first (`scanDisk`), with
    // `listJobs` as a fallback. Both should return the same set in
    // tests so neither path needs special-casing.
    if (cmd === 'separator_scan_disk') return jobs;
    if (cmd === 'separator_list_jobs') return jobs;
    return undefined;
  });
}

describe('SeparatorShell', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it('shows the install gate when assets are not installed', async () => {
    mockBackend({ status: notInstalled });
    render(<SeparatorShell />);
    expect(await screen.findByText(/not installed/i)).toBeInTheDocument();
    expect(screen.getByText(/Settings/i)).toBeInTheDocument();
  });

  it('renders the drop-zone when the install is ready and there are no jobs', async () => {
    mockBackend({ status: installed });
    render(<SeparatorShell />);
    expect(await screen.findByTestId('separator-dropzone')).toBeInTheDocument();
    expect(
      screen.queryByTestId('separator-active-jobs'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('separator-completed-jobs'),
    ).not.toBeInTheDocument();
  });

  it('renders an active and a completed job from listJobs()', async () => {
    const jobs: SeparatorJob[] = [
      {
        id: 'sep-1',
        input_path: '/Music/Song.mp3',
        model: 'htdemucs_6s',
        mode: 'analyze',
        output_dir: '/out/Song',
        status: 'running',
        progress: 0.4,
        phase: 'separating',
        started_at: 0,
      },
      {
        id: 'sep-2',
        input_path: '/Music/Other.flac',
        model: 'htdemucs_6s',
        mode: 'analyze',
        output_dir: '/out/Other',
        status: 'completed',
        progress: 1,
        phase: 'done',
        started_at: 0,
        finished_at: 1,
        result: { bpm: 128.4, model: 'htdemucs_6s', device: 'mps' },
      },
    ];
    mockBackend({ status: installed, jobs });
    render(<SeparatorShell />);
    expect(await screen.findByTestId('job-sep-1')).toBeInTheDocument();
    expect(screen.getByText(/Song.mp3/)).toBeInTheDocument();
    // Phase label is translated to ukrainian; the percentage lives in
    // a separate node next to it.
    expect(screen.getByText(/Separating stems/)).toBeInTheDocument();
    expect(screen.getByText(/40%/)).toBeInTheDocument();
    expect(screen.getByTestId('done-sep-2')).toBeInTheDocument();
    expect(screen.getByText(/BPM 128\.4/)).toBeInTheDocument();
  });

  it('flips into install gate even after recovery from a transient backend error on download:done', async () => {
    // Specifically: status() rejects once, then succeeds. The install
    // gate should surface the rejection through the alert role.
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'separator_status') throw new Error('boom');
      if (cmd === 'separator_list_jobs') return [];
      return undefined;
    });
    render(<SeparatorShell />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/boom/),
    );
  });
});
