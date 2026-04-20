import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PostureBadge } from './PostureBadge';

describe('PostureBadge', () => {
  it('renders the posture label for each variant', () => {
    render(
      <>
        <PostureBadge posture="sit" />
        <PostureBadge posture="stand" />
        <PostureBadge posture="walk" />
      </>,
    );
    expect(screen.getByText('Sit')).toBeInTheDocument();
    expect(screen.getByText('Stand')).toBeInTheDocument();
    expect(screen.getByText('Walk')).toBeInTheDocument();
  });

  it('exposes posture via aria-label for screen readers', () => {
    render(<PostureBadge posture="walk" />);
    expect(screen.getByLabelText('Posture: Walk')).toBeInTheDocument();
  });
});
