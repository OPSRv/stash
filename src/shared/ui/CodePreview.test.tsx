import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CodePreview } from './CodePreview';

describe('CodePreview', () => {
  it('renders the code through the shared Markdown pipeline', async () => {
    const { container } = render(
      <CodePreview code={'const x = 1;'} language="javascript" />,
    );
    await waitFor(
      () => {
        const pre = container.querySelector('pre code');
        expect(pre?.className ?? '').toContain('language-javascript');
      },
      { timeout: 5000 },
    );
  });

  it('tags TSX code with the typescript grammar', async () => {
    const { container } = render(
      <CodePreview code={'const X = <div/>;'} language="typescript" />,
    );
    await waitFor(
      () => {
        const pre = container.querySelector('pre code');
        expect(pre?.className ?? '').toContain('language-typescript');
      },
      { timeout: 5000 },
    );
  });

  it('renders the filename header when provided', () => {
    const { getByText } = render(
      <CodePreview code={'{}'} language="json" filename="pkg.json" />,
    );
    expect(getByText('pkg.json')).toBeInTheDocument();
  });

  it('falls back to plaintext when no language is passed', async () => {
    const { container } = render(<CodePreview code={'hello'} />);
    await waitFor(
      () => {
        const pre = container.querySelector('pre code');
        expect(pre?.className ?? '').toContain('language-plaintext');
      },
      { timeout: 5000 },
    );
  });
});
