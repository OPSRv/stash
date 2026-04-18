import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SearchInput } from './SearchInput';

describe('SearchInput', () => {
  it('renders with a placeholder', () => {
    render(<SearchInput value="" onChange={() => {}} placeholder="Search clipboard" />);
    expect(screen.getByPlaceholderText('Search clipboard')).toBeInTheDocument();
  });

  it('calls onChange with new value on typing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} placeholder="Search" />);
    await user.type(screen.getByRole('searchbox'), 'hi');
    expect(onChange).toHaveBeenLastCalledWith('i');
  });

  it('reflects the current value', () => {
    render(<SearchInput value="abc" onChange={() => {}} placeholder="Search" />);
    expect(screen.getByRole('searchbox')).toHaveValue('abc');
  });

  it('renders shortcut hint when provided', () => {
    render(
      <SearchInput value="" onChange={() => {}} placeholder="Search" shortcutHint="⌘K" />
    );
    expect(screen.getByText('⌘K')).toBeInTheDocument();
  });
});
