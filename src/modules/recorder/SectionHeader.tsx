import type { ReactNode } from 'react';

interface SectionHeaderProps {
  children: ReactNode;
}

export const SectionHeader = ({ children }: SectionHeaderProps) => (
  <div className="t-tertiary text-meta uppercase tracking-wider mb-2 font-medium">
    {children}
  </div>
);
