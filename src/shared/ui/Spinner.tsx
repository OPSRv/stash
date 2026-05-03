interface SpinnerProps {
  size?: number;
  /** Extra classes appended to the default spinner styles. The base
   *  classes always render (border, animation, rounded shape). */
  className?: string;
}

export const Spinner = ({ size = 12, className }: SpinnerProps) => (
  <span
    aria-hidden="true"
    className={
      `inline-block rounded-full border-2 border-white/30 border-t-white/90 animate-spin ${className ?? ''}`.trim()
    }
    style={{ width: size, height: size }}
  />
);
