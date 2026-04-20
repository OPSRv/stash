import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhisperModelList } from './WhisperModelList';
import type { ModelRow } from './api';

const baseRow: ModelRow = {
  id: 'base',
  label: 'Base · Multilingual',
  size_bytes: 147_951_465,
  ram_mb: 500,
  language: 'multi',
  quantized: false,
  accuracy: 2,
  realtime_intel_2018: 6,
  recommended_intel: false,
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  downloaded: true,
  active: false,
};

const smallRow: ModelRow = {
  ...baseRow,
  id: 'small',
  label: 'Small · Multilingual',
  size_bytes: 487_601_387,
  ram_mb: 1024,
  realtime_intel_2018: 2.3,
  accuracy: 3,
  recommended_intel: true,
  downloaded: false,
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
};

const mocks = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([] as ModelRow[]),
  download: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
  setActive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./api', () => ({
  whisperListModels: mocks.list,
  whisperDownloadModel: mocks.download,
  whisperDeleteModel: mocks.del,
  whisperSetActive: mocks.setActive,
  whisperGetActive: vi.fn().mockResolvedValue(null),
  whisperTranscribe: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

afterEach(() => {
  mocks.list.mockReset();
  mocks.download.mockReset();
  mocks.del.mockReset();
  mocks.setActive.mockReset();
  mocks.list.mockResolvedValue([]);
  mocks.download.mockResolvedValue(undefined);
  mocks.del.mockResolvedValue(undefined);
  mocks.setActive.mockResolvedValue(undefined);
});

describe('WhisperModelList', () => {
  it('renders rows and highlights the recommended tier', async () => {
    mocks.list.mockResolvedValue([baseRow, smallRow]);
    render(<WhisperModelList />);
    await waitFor(() => expect(screen.getByTestId('model-row-base')).toBeInTheDocument());
    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });

  it('Use button triggers set-active', async () => {
    mocks.list.mockResolvedValue([baseRow]);
    render(<WhisperModelList />);
    await waitFor(() => expect(screen.getByTestId('model-use-base')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('model-use-base'));
    await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith('base'));
  });

  it('Download button triggers download', async () => {
    mocks.list.mockResolvedValue([smallRow]);
    render(<WhisperModelList />);
    await waitFor(() => expect(screen.getByTestId('model-download-small')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('model-download-small'));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith('small'));
  });

  it('pauses subscriptions when inactive', () => {
    render(<WhisperModelList active={false} />);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
