import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DetectSkeletonCard } from './DetectSkeletonCard';

describe('DetectSkeletonCard', () => {
  it('shows the first-stage label immediately', () => {
    render(<DetectSkeletonCard elapsedSec={0} />);
    expect(screen.getByText(/fetching preview/i)).toBeInTheDocument();
  });

  it('escalates to "Resolving formats" after 4s', () => {
    render(<DetectSkeletonCard elapsedSec={6} />);
    expect(screen.getByText(/resolving formats/i)).toBeInTheDocument();
  });

  it('acknowledges slow fetches after 12s', () => {
    render(<DetectSkeletonCard elapsedSec={15} />);
    expect(screen.getByText(/slow today/i)).toBeInTheDocument();
  });

  it('shows almost-there copy near the 25s mark', () => {
    render(<DetectSkeletonCard elapsedSec={30} />);
    expect(screen.getByText(/almost there/i)).toBeInTheDocument();
  });

  it('appends elapsed seconds once past 4s', () => {
    render(<DetectSkeletonCard elapsedSec={8} />);
    expect(screen.getByText(/8s/)).toBeInTheDocument();
  });
});
