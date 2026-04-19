import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { TrafficLights } from './TrafficLights';

describe('TrafficLights', () => {
  it('renders three dots with tl + colour classes', () => {
    const { container } = render(<TrafficLights />);
    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(3);
    expect(spans[0].className).toContain('tl-red');
    expect(spans[1].className).toContain('tl-yellow');
    expect(spans[2].className).toContain('tl-green');
  });

  it('forwards className', () => {
    const { container } = render(<TrafficLights className="extra" />);
    expect((container.firstChild as HTMLElement).className).toContain('extra');
  });
});
