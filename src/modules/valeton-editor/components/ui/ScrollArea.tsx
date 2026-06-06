import type { ReactNode } from 'react';

/** Кастомна область прокрутки з тонким скролбаром і стабільним gutter
   (щоб поява скролбара не зсувала/не стрибала макет). Глобальної прокрутки немає. */
export const ScrollArea = ({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}) => <div className={`scroll-area ${className}`}>{children}</div>;
