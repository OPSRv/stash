import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ListItemRow } from './ListItemRow';

describe('ListItemRow', () => {
  it('renders title, meta, leading and trailing slots', () => {
    render(
      <ul>
        <ListItemRow
          leading={<span data-testid="lead">◉</span>}
          title="row title"
          meta="secondary info"
          trailing={<span data-testid="trail">→</span>}
        />
      </ul>,
    );
    expect(screen.getByText('row title')).toBeInTheDocument();
    expect(screen.getByText('secondary info')).toBeInTheDocument();
    expect(screen.getByTestId('lead')).toBeInTheDocument();
    expect(screen.getByTestId('trail')).toBeInTheDocument();
  });

  it('fires onClick when interactive', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <ul>
        <ListItemRow title="t" onClick={onClick} />
      </ul>,
    );
    await user.click(screen.getByText('t'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies the selected style when selected + interactive', () => {
    const { container } = render(
      <ul>
        <ListItemRow title="t" selected onClick={() => {}} />
      </ul>,
    );
    const li = container.querySelector('li');
    expect(li?.className).toContain('bg-white/[0.05]');
  });
});
