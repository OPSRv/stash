import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CompletedRow } from './CompletedRow';
import type { SeparatorJob } from './api';

const baseJob = (overrides: Partial<SeparatorJob> = {}): SeparatorJob => ({
  id: 'job-1',
  input_path: '/Music/Stash Stems/song.m4a',
  model: 'htdemucs_6s',
  mode: 'separate',
  output_dir: '/Music/Stash Stems/job-1',
  status: 'completed',
  phase: 'done',
  progress: 1,
  started_at: 0,
  finished_at: 0,
  result: {
    bpm: 128,
    duration_sec: 240,
    model: 'htdemucs_6s',
    device: 'mps',
    stems_dir: '/Music/Stash Stems/job-1',
    stems: {
      vocals: '/Music/Stash Stems/job-1/vocals.wav',
      drums: '/Music/Stash Stems/job-1/drums.wav',
      bass: '/Music/Stash Stems/job-1/bass.wav',
    },
  },
  ...overrides,
});

describe('CompletedRow', () => {
  it('renders an inline audio player for the source file and every stem', () => {
    const { container } = render(
      <CompletedRow job={baseJob()} onRemove={vi.fn()} />,
    );
    // 1 source player + 3 stem players = 4 `<audio>` elements.
    expect(container.querySelectorAll('audio')).toHaveLength(4);
    // Stem cards each surface their player and label.
    expect(screen.getByTestId('stem-vocals')).toBeInTheDocument();
    expect(screen.getByTestId('stem-drums')).toBeInTheDocument();
    expect(screen.getByTestId('stem-bass')).toBeInTheDocument();
  });

  it('does not render the source player for a failed job (file may not exist)', () => {
    const { container } = render(
      <CompletedRow
        job={baseJob({ status: 'failed', error: 'demucs crashed', result: undefined })}
        onRemove={vi.fn()}
      />,
    );
    // No source player and no stems → zero audio elements.
    expect(container.querySelectorAll('audio')).toHaveLength(0);
    expect(screen.getByTestId('job-error')).toBeInTheDocument();
  });

  it('exposes hover-only Finder/Copy actions for each stem', () => {
    render(<CompletedRow job={baseJob()} onRemove={vi.fn()} />);
    // Each stem ships its own action cluster — opacity-0 by default,
    // surfaced on hover; we just assert the cluster exists.
    expect(screen.getByTestId('stem-vocals-actions')).toBeInTheDocument();
    expect(screen.getByTestId('stem-drums-actions')).toBeInTheDocument();
    expect(screen.getByTestId('stem-bass-actions')).toBeInTheDocument();
  });
});
