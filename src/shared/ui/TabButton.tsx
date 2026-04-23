import { forwardRef, type ReactNode } from 'react';

type TabButtonProps = {
  label: string;
  icon?: ReactNode;
  shortcutHint?: string;
  active: boolean;
  onClick: () => void;
  onHover?: () => void;
};

export const TabButton = forwardRef<HTMLButtonElement, TabButtonProps>(
  ({ label, icon, shortcutHint, active, onClick, onHover }, ref) => {
    // Collapse to icon-only when the tab isn't active, so 10+ tabs still fit
    // in the popup header. The label stays in the DOM (aria-label + title)
    // for screen readers and the hover tooltip; only its visible width
    // animates. When no icon is provided we always show the label.
    const collapsed = !!icon && !active;
    // Emphasized spring-y easing matches the active-tab underline in
    // PopupShell, so the label expansion and the underline travel together.
    const emphasized = 'cubic-bezier(0.2, 0, 0, 1)';
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        onMouseEnter={onHover}
        onFocus={onHover}
        aria-current={active ? 'true' : undefined}
        aria-label={label}
        title={shortcutHint ? `${label} (${shortcutHint})` : label}
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
    );
  },
);
TabButton.displayName = 'TabButton';
