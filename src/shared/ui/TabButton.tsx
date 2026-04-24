import { forwardRef, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';

type TabButtonProps = {
  label: string;
  icon?: ReactNode;
  active: boolean;
  onClick: () => void;
  onHover?: () => void;
};

export const TabButton = forwardRef<HTMLButtonElement, TabButtonProps>(
  ({ label, icon, active, onClick, onHover }, ref) => {
    // Collapse to icon-only when the tab isn't active, so 10+ tabs still fit
    // in the popup header. The label stays in the DOM as aria-label and via
    // the custom Tooltip for screen readers and hover discovery; only its
    // visible width animates. When no icon is provided we always show the label.
    const collapsed = !!icon && !active;
    // Emphasized spring-y easing matches the active-tab pill sweep in
    // PopupShell, so both motions feel like one continuous gesture.
    const emphasized = 'cubic-bezier(0.2, 0, 0, 1)';
    return (
      <Tooltip label={collapsed ? label : undefined} side="bottom">
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          onMouseEnter={onHover}
          onFocus={onHover}
          aria-current={active ? 'true' : undefined}
          aria-label={label}
          className={`relative h-7 ${icon ? 'px-2' : 'px-2.5'} rounded-md text-meta font-medium inline-flex items-center whitespace-nowrap cursor-pointer ring-focus-sm transition-colors duration-150 ${
            active ? 't-primary' : 't-secondary hover:t-primary'
          }`}
        >
          {icon && (
            <span
              className={`inline-flex shrink-0 transition-transform duration-[260ms] motion-reduce:transition-none ${
                active ? 'scale-110' : 'scale-100'
              }`}
              style={{ transitionTimingFunction: emphasized }}
            >
              {icon}
            </span>
          )}
          {/*
            Grid-template-columns 0fr→1fr trick — animates the label to its
            *actual* content width instead of a fixed max-width cap, so the
            expansion doesn't stall on empty space and the indicator travels
            exactly with the content edge. `min-w-0` on the inner span lets
            the track collapse cleanly.
          */}
          <span
            aria-hidden={collapsed || undefined}
            className={`grid transition-[grid-template-columns,opacity,margin-left,transform] duration-[260ms] motion-reduce:transition-none ${
              collapsed
                ? 'grid-cols-[0fr] opacity-0 ml-0 -translate-x-1'
                : `grid-cols-[1fr] opacity-100 translate-x-0 ${icon ? 'ml-1.5' : ''}`
            }`}
            style={{ transitionTimingFunction: emphasized }}
          >
            <span className="min-w-0 overflow-hidden">{label}</span>
          </span>
        </button>
      </Tooltip>
    );
  },
);
TabButton.displayName = 'TabButton';
