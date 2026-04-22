import { accent } from '../../shared/theme/accent';

type Props = {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  /// Upper bound for the Y axis. Defaults to the max of `values` with a
  /// sensible minimum so a flat zero series doesn't render a sideways line
  /// at the canvas top.
  max?: number;
};

export const Sparkline = ({ values, width = 120, height = 32, color, max }: Props) => {
  const c = color ?? accent(1);
  if (values.length === 0) {
    return <svg width={width} height={height} aria-hidden />;
  }
  const top = max ?? Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - (Math.min(top, Math.max(0, v)) / top) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  // Area path = line path + two bottom corners, for the soft gradient fill.
  const areaPath = `M0,${height} L${points.replace(/ /g, ' L')} L${width},${height} Z`;
  const linePath = `M${points.replace(/ /g, ' L')}`;
  const gid = `sp-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <svg width={width} height={height} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity={0.45} />
          <stop offset="100%" stopColor={c} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gid})`} />
      <path d={linePath} stroke={c} strokeWidth={1.6} fill="none" strokeLinecap="round" />
    </svg>
  );
};
