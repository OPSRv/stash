import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PanelHeader } from './PanelHeader';

describe('PanelHeader', () => {
  it('renders title, description, icon, and trailing slot', () => {
    render(
      <PanelHeader
        gradient={['#5ee2c4', '#2aa3ff']}
        icon={<svg data-testid="icon" />}
        title="Кеші"
        description="Довгий опис"
        trailing={<button>Оновити</button>}
      />,
    );
    expect(screen.getByText('Кеші')).toBeInTheDocument();
    expect(screen.getByText('Довгий опис')).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Оновити' })).toBeInTheDocument();
  });

  it('works without description or trailing', () => {
    render(
      <PanelHeader gradient={['#5ee2c4', '#17b26a']} icon={null} title="Solo" />,
    );
    expect(screen.getByText('Solo')).toBeInTheDocument();
  });

  it('derives header wash and blob from the two gradient stops', () => {
    const { container } = render(
      <PanelHeader gradient={['#d08cff', '#7b61ff']} icon={null} title="X" />,
    );
    const header = container.querySelector('header');
    const style = header?.getAttribute('style') ?? '';
    // rgb parts of #d08cff = 208,140,255 and #7b61ff = 123,97,255
    expect(style.replace(/\s/g, '')).toContain('208,140,255');
    expect(style.replace(/\s/g, '')).toContain('123,97,255');
  });
});
