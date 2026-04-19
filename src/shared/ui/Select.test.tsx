import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Select } from './Select';

const OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'de', label: 'German' },
];

describe('Select', () => {
  it('renders the selected label as the trigger', () => {
    render(<Select value="uk" onChange={() => {}} options={OPTIONS} label="Language" />);
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent('Ukrainian');
  });

  it('falls back to placeholder when value is empty', () => {
    const opts = [{ value: '', label: 'None' }, ...OPTIONS];
    render(<Select value="" onChange={() => {}} options={opts} placeholder="Pick one" />);
    expect(screen.getByRole('combobox')).toHaveTextContent('None');
  });

  it('opens the listbox on click and shows all options', async () => {
    const user = userEvent.setup();
    render(<Select value="en" onChange={() => {}} options={OPTIONS} />);
    await user.click(screen.getByRole('combobox'));
    const list = screen.getByRole('listbox');
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('selects an option on click and closes the listbox', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select value="en" onChange={onChange} options={OPTIONS} />);
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'German' }));
    expect(onChange).toHaveBeenCalledWith('de');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('navigates with ArrowDown/ArrowUp and commits with Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select value="en" onChange={onChange} options={OPTIONS} />);
    const trigger = screen.getByRole('combobox');
    trigger.focus();
    await user.keyboard('{ArrowDown}'); // open + highlight current (en)
    await user.keyboard('{ArrowDown}'); // → uk
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('uk');
  });

  it('closes on Escape without firing onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select value="en" onChange={onChange} options={OPTIONS} />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('marks the active option with aria-selected', async () => {
    const user = userEvent.setup();
    render(<Select value="uk" onChange={() => {}} options={OPTIONS} />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Ukrainian' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('option', { name: 'English' })).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });
});
