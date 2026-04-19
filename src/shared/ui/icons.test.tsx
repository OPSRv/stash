import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CheckIcon,
  CloseIcon,
  LinkIcon,
  PauseIcon,
  PlayIcon,
} from './icons';

const icons = [
  ['LinkIcon', LinkIcon],
  ['CloseIcon', CloseIcon],
  ['CheckIcon', CheckIcon],
  ['PlayIcon', PlayIcon],
  ['PauseIcon', PauseIcon],
] as const;

describe('icons', () => {
  it.each(icons)('%s renders an <svg> with the default size', (_, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('width')).toBeTruthy();
  });

  it.each(icons)('%s honours custom size and className', (_, Icon) => {
    const { container } = render(<Icon size={20} className="icon-class" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('class')).toContain('icon-class');
  });
});
