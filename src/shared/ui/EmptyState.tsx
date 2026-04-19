import type { ReactNode } from 'react';

type Props = {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  variant?: 'default' | 'compact';
  className?: string;
};

export const EmptyState = ({
  title,
  description,
  icon,
  action,
  variant = 'default',
  className = '',
}: Props) => {
  const pad = variant === 'compact' ? 'py-6 px-4' : 'py-10 px-6';
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center text-center ${pad} ${className}`}
    >
      {icon ? (
        <div className="t-tertiary mb-3 flex items-center justify-center opacity-70">
          {icon}
        </div>
      ) : null}
      <div className="t-primary text-title font-medium mb-1">{title}</div>
      {description ? (
        <div className="t-secondary text-body max-w-[320px]">{description}</div>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
};
