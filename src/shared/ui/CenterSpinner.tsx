import { Spinner } from './Spinner';

type CenterSpinnerProps = {
  /// `fill` covers the full height of the parent (`h-full`), used in panels
  /// whose body flexes to remaining space. `inline` keeps a modest vertical
  /// padding for inline loading inside a flow of content.
  fit?: 'fill' | 'inline';
};

/// Centered loading state. Previously open-coded as
/// `<div className="flex items-center justify-center …"><Spinner /></div>`
/// in almost every system panel.
export const CenterSpinner = ({ fit = 'fill' }: CenterSpinnerProps) => (
  <div
    className={`flex items-center justify-center ${fit === 'fill' ? 'h-full' : 'py-10'}`}
  >
    <Spinner />
  </div>
);
