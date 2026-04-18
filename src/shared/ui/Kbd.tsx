import type { ReactNode } from 'react';

type KbdProps = {
  children: ReactNode;
};

export const Kbd = ({ children }: KbdProps) => <span className="kbd">{children}</span>;
