import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { GlobalSearch } from './GlobalSearch';

describe('GlobalSearch', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue([] as never);
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <GlobalSearch open={false} onClose={() => {}} onNavigate={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('debounces and fires global_search when the user types', async () => {
    const user = userEvent.setup();
    render(<GlobalSearch open onClose={() => {}} onNavigate={() => {}} />);
    const input = screen.getByPlaceholderText('Search clipboard, downloads, notes…');
    await user.type(input, 'hi');
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('global_search', { query: 'hi' });
    });
  });

  it('shows "No results" when query non-empty and hits are empty', async () => {
    const user = userEvent.setup();
    render(<GlobalSearch open onClose={() => {}} onNavigate={() => {}} />);
    await user.type(
      screen.getByPlaceholderText('Search clipboard, downloads, notes…'),
      'xyz'
    );
    await waitFor(() => expect(screen.getByText('No results.')).toBeInTheDocument());
  });

  it('renders hits returned from the backend and navigates on click', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { kind: 'note', id: 1, title: 'My Note', snippet: 'snippet', ts: 0 },
    ] as never);
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<GlobalSearch open onClose={onClose} onNavigate={onNavigate} />);
    await user.type(
      screen.getByPlaceholderText('Search clipboard, downloads, notes…'),
      'my'
    );
    const hit = await screen.findByText('My Note');
    await user.click(hit);
    expect(onNavigate).toHaveBeenCalledWith('notes');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<GlobalSearch open onClose={onClose} onNavigate={() => {}} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
