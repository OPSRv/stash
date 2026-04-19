/// SVG constants used exclusively by Select's popup chrome. Split into
/// their own file to keep Select.tsx a single-component module per the
/// react-conventions rule, while staying co-located with Select.

interface ChevronIconProps {
  open: boolean;
}

export const ChevronIcon = ({ open }: ChevronIconProps) => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    aria-hidden="true"
    className="t-secondary shrink-0 transition-transform"
    style={{ transform: `rotate(${open ? 180 : 0}deg)` }}
  >
    <path
      d="M2 4l3 3 3-3"
      stroke="currentColor"
      strokeWidth="1.4"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const SelectCheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="t-secondary">
    <path
      d="M2.5 6.5l2.5 2.5 4.5-5"
      stroke="currentColor"
      strokeWidth="1.6"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
