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
  it('renders the source player and a mixer lane for every stem', () => {
    render(<CompletedRow job={baseJob()} onRemove={vi.fn()} />);
    // Stems now play through a single Web Audio mixer, not per-stem
    // `<audio>` elements: one lane per stem inside the StemMixer.
    expect(screen.getByTestId('stem-mixer')).toBeInTheDocument();
    expect(screen.getByTestId('mixer-lane-vocals')).toBeInTheDocument();
    expect(screen.getByTestId('mixer-lane-drums')).toBeInTheDocument();
    expect(screen.getByTestId('mixer-lane-bass')).toBeInTheDocument();
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
    // Each mixer lane ships its own action cluster — opacity-0 by
    // default, surfaced on hover; we just assert the cluster exists.
    expect(screen.getByTestId('mixer-lane-vocals-actions')).toBeInTheDocument();
    expect(screen.getByTestId('mixer-lane-drums-actions')).toBeInTheDocument();
    expect(screen.getByTestId('mixer-lane-bass-actions')).toBeInTheDocument();
  });
});
