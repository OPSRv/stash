import { Fragment } from 'react';
import { parseBlocks, type Block, type Inline } from './markdown';

type Props = {
  source: string;
  onToggleCheckbox?: (line: number) => void;
};

const renderInline = (nodes: Inline[], keyPrefix: string) =>
  nodes.map((n, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (n.kind) {
      case 'bold':
        return (
          <strong key={key} className="font-semibold">
            {n.value}
          </strong>
        );
      case 'italic':
        return (
          <em key={key} className="italic">
            {n.value}
          </em>
        );
      case 'code':
        return (
          <code key={key} className="px-1 py-0.5 rounded bg-white/[0.08] font-mono text-[0.9em]">
            {n.value}
          </code>
        );
      case 'link':
        return (
          <a
            key={key}
            href={n.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[#4A8BEA] underline decoration-dotted"
          >
            {n.value}
          </a>
        );
      case 'text':
      default:
        return <Fragment key={key}>{n.value}</Fragment>;
    }
  });

const headingClass: Record<1 | 2 | 3, string> = {
  1: 'text-[20px] font-semibold mt-3 mb-2',
  2: 'text-[16px] font-semibold mt-3 mb-1.5',
  3: 'text-[14px] font-semibold mt-2 mb-1',
};

const renderBlock = (
  block: Block,
  key: number,
  onToggleCheckbox?: Props['onToggleCheckbox'],
) => {
  switch (block.kind) {
    case 'heading':
      return (
        <div key={key} className={`t-primary ${headingClass[block.level]}`}>
          {renderInline(block.inline, `h${key}`)}
        </div>
      );
    case 'paragraph':
      return (
        <p key={key} className="t-primary text-body my-1 leading-relaxed">
          {renderInline(block.inline, `p${key}`)}
        </p>
      );
    case 'blockquote':
      return (
        <blockquote
          key={key}
          className="t-secondary text-body my-2 pl-3 border-l-2 border-white/15 italic"
        >
          {renderInline(block.inline, `q${key}`)}
        </blockquote>
      );
    case 'code':
      return (
        <pre
          key={key}
          className="t-primary my-2 rounded-md bg-white/[0.04] border border-white/5 px-3 py-2 font-mono text-[12px] overflow-x-auto whitespace-pre"
        >
          {block.value}
        </pre>
      );
    case 'hr':
      return <hr key={key} className="my-3 border-white/10" />;
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          key={key}
          className={`my-1 pl-${block.ordered ? '5' : '4'} ${
            block.ordered ? 'list-decimal' : 'list-disc'
          } t-primary text-body space-y-0.5`}
        >
          {block.items.map((item, i) => {
            if (item.checked !== null) {
              const checked = item.checked;
              return (
                <li key={i} className="list-none flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleCheckbox?.(item.line)}
                    className="mt-1 cursor-pointer"
                    aria-label={checked ? 'Mark as not done' : 'Mark as done'}
                  />
                  <span className={checked ? 't-tertiary line-through' : ''}>
                    {renderInline(item.inline, `ck${key}-${i}`)}
                  </span>
                </li>
              );
            }
            return (
              <li key={i}>{renderInline(item.inline, `li${key}-${i}`)}</li>
            );
          })}
        </Tag>
      );
    }
  }
};

export const MarkdownPreview = ({ source, onToggleCheckbox }: Props) => {
  const blocks = parseBlocks(source);
  if (blocks.length === 0) {
    return (
      <div className="t-tertiary text-meta italic">Empty — start typing on the left.</div>
    );
  }
  return (
    <div className="text-body">
      {blocks.map((b, i) => renderBlock(b, i, onToggleCheckbox))}
    </div>
  );
};
