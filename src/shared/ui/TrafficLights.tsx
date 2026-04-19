type TrafficLightsProps = {
  className?: string;
};

export const TrafficLights = ({ className = '' }: TrafficLightsProps) => (
  <div className={`flex items-center gap-1.5 ${className}`} aria-hidden="true">
    <span className="tl tl-red" />
    <span className="tl tl-yellow" />
    <span className="tl tl-green" />
  </div>
);
