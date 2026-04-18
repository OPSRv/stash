import type { ReactNode } from 'react';

type SectionLabelProps = {
  children: ReactNode;
};

export const SectionLabel = ({ children }: SectionLabelProps) => (
  <span className="section-label">{children}</span>
);
