import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatCard } from './StatCard';

describe('StatCard', () => {
  it('renders value, eyebrow, hint', () => {
    render(
      <StatCard
        gradient={['#7ef7a5', '#17b26a']}
        eyebrow="WI-FI"
        value="1.2 MB/s"
        hint="en0"
      />,
    );
    expect(screen.getByText('WI-FI')).toBeInTheDocument();
    expect(screen.getByText('1.2 MB/s')).toBeInTheDocument();
    expect(screen.getByText('en0')).toBeInTheDocument();
  });

  it('renders trailing and footer slots', () => {
    render(
      <StatCard
        gradient={['#5ee2c4', '#2aa3ff']}
        value="42%"
        trailing={<span data-testid="trail">t</span>}
        footer={<span data-testid="foot">f</span>}
      />,
    );
    expect(screen.getByTestId('trail')).toBeInTheDocument();
    expect(screen.getByTestId('foot')).toBeInTheDocument();
  });
});
