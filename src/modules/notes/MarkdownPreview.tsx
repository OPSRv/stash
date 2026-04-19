import { useMemo } from 'react';
import type { Components } from 'react-markdown';

import { Markdown } from '../../shared/ui/Markdown';

type Props = {
  source: string;
  onToggleCheckbox?: (line: number) => void;
};

// remark-gfm parses `- [ ] task` into <li class="task-list-item"> with a
// disabled <input type="checkbox">. We want those checkboxes clickable and
// to call `onToggleCheckbox(line)`. react-markdown strips position info from
// element props by default, so we recover the source line of each task item
// by scanning the raw source once and mapping checkbox occurrences to their
// line numbers in order.
const collectTaskLines = (source: string): number[] => {
  const re = /^\s*([-*+]|\d+\.)\s+\[( |x|X)\]/;
  const out: number[] = [];
  source.split('\n').forEach((line, i) => {
    if (re.test(line)) out.push(i);
  });
  return out;
};

export const MarkdownPreview = ({ source, onToggleCheckbox }: Props) => {
  const taskLines = useMemo(() => collectTaskLines(source), [source]);

  const components: Components = useMemo(() => {
    let taskIndex = 0;
    return {
      input: ({ type, checked, ...rest }) => {
        if (type !== 'checkbox') return <input type={type} {...rest} />;
        const line = taskLines[taskIndex++];
        return (
          <input
            type="checkbox"
            checked={!!checked}
            onChange={() => line !== undefined && onToggleCheckbox?.(line)}
            className="mt-1 cursor-pointer"
            aria-label={checked ? 'Mark as not done' : 'Mark as done'}
          />
        );
      },
    };
  }, [onToggleCheckbox, taskLines]);

  if (!source.trim()) {
    return (
      <div className="t-tertiary text-meta italic">Empty — start typing on the left.</div>
    );
  }

  return (
    <div className="notes-md">
      <Markdown source={source} components={components} />
    </div>
  );
};
