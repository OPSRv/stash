import type { HTMLAttributes, ReactNode } from 'react';

export type SurfaceElevation = 'flat' | 'raised';
export type SurfaceRadius = 'md' | 'lg' | 'xl' | '2xl' | 'full';

type SurfaceProps = HTMLAttributes<HTMLDivElement> & {
  elevation?: SurfaceElevation;
  rounded?: SurfaceRadius;
  children?: ReactNode;
};

const radiusClass: Record<SurfaceRadius, string> = {
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
  full: 'rounded-full',
};

export const Surface = ({
  elevation = 'flat',
  rounded = 'lg',
  className = '',
  children,
  ...rest
}: SurfaceProps) => (
  <div
    className={`pane ${elevation === 'raised' ? 'pane-elev' : ''} ${radiusClass[rounded]} ${className}`}
    {...rest}
  >
    {children}
  </div>
);
