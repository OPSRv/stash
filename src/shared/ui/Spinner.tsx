interface SpinnerProps {
  size?: number;
}

export const Spinner = ({ size = 12 }: SpinnerProps) => (
  <span
    aria-hidden="true"
    className="inline-block rounded-full border-2 border-white/30 border-t-white/90 animate-spin"
    style={{ width: size, height: size }}
  />
);
