import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PopupShell } from './PopupShell';

describe('PopupShell', () => {
  it('renders the active module popup view', () => {
    const { container } = render(<PopupShell />);
    // Default module is clipboard; its popup renders a search input.
    expect(container.querySelector('[role="searchbox"]')).toBeInTheDocument();
  });

  it('wraps content in a pane container', () => {
    const { container } = render(<PopupShell />);
    expect(container.querySelector('.pane')).toBeInTheDocument();
  });
});
