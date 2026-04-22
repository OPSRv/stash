/// Hero loader — animated globe used as the app/tab bootstrap state. Sized
/// for the 920×520 popup body; scales down via the `scale` prop.
///
/// The 60 halo dots are precomputed once at module scope (object pool) so
/// every mount of `<GlobeLoader />` reuses the same array — Suspense
/// fallbacks can flicker in/out per tab open without recomputing trig.
type Dot = { x: number; y: number; r: number };

const RING_DOTS: readonly Dot[] = (() => {
  const cx = 200;
  const cy = 200;
  const r = 190;
  const count = 60;
  const out: Dot[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push({
      x: +(cx + Math.cos(a) * r).toFixed(1),
      y: +(cy + Math.sin(a) * r).toFixed(1),
      r: i % 6 === 0 ? 1.6 : 0.8,
    });
  }
  return out;
})();

type GlobeLoaderProps = {
  /// Optional caption rendered under the globe.
  caption?: string;
  /// Optional sub-line (e.g. progress detail). Mono-styled.
  detail?: string;
  /// Visual scale; defaults to 1 (= 400×400 SVG). Use 0.5 for a 200×200
  /// inline footprint.
  scale?: number;
  /// When true, fills the parent and centres horizontally and vertically.
  /// Otherwise rendered inline.
  fill?: boolean;
};

export const GlobeLoader = ({
  caption,
  detail,
  scale = 1,
  fill = true,
}: GlobeLoaderProps) => {
  const wrap = fill
    ? 'flex flex-col items-center justify-center w-full h-full'
    : 'inline-flex flex-col items-center';
  const size = Math.round(400 * scale);
  return (
    <div className={wrap} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{caption ?? 'Loading…'}</span>
      <div
        className="relative"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {/* Background accent glow */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(50% 42% at 50% 50%, rgba(47,122,229,0.18) 0%, transparent 60%), radial-gradient(40% 25% at 50% 80%, rgba(123,84,232,0.10) 0%, transparent 70%)',
          }}
        />
        <svg
          width={size}
          height={size}
          viewBox="0 0 400 400"
          className="relative z-10"
        >
          <defs>
            <radialGradient id="globe-sphere" cx="38%" cy="32%" r="70%">
              <stop offset="0%" stopColor="#6FA7F5" stopOpacity="0.45" />
              <stop offset="45%" stopColor="#2F7AE5" stopOpacity="0.20" />
              <stop offset="100%" stopColor="#0A1834" stopOpacity="0.70" />
            </radialGradient>
            <radialGradient id="globe-sphere-light" cx="38%" cy="32%" r="70%">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.9" />
              <stop offset="50%" stopColor="#B9D2F5" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#2F7AE5" stopOpacity="0.25" />
            </radialGradient>
            <linearGradient id="globe-orbit" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#2F7AE5" stopOpacity="0" />
              <stop offset="50%" stopColor="#6FA7F5" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#2F7AE5" stopOpacity="0" />
            </linearGradient>
            <filter id="globe-soft" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.2" />
            </filter>
            <filter
              id="globe-strong"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feGaussianBlur stdDeviation="3" />
            </filter>
            <clipPath id="globe-clip">
              <circle cx="200" cy="200" r="120" />
            </clipPath>
          </defs>

          {/* Halo + dotted ring */}
          <g opacity="0.55">
            <circle
              cx="200"
              cy="200"
              r="170"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.08"
              strokeWidth="1"
            />
            {RING_DOTS.map((d, i) => (
              <circle
                key={i}
                cx={d.x}
                cy={d.y}
                r={d.r}
                className="globe-ring-dot"
              />
            ))}
          </g>

          {/* Outer orbits */}
          <g transform="translate(200 200)">
            <g className="globe-spin">
              <ellipse
                cx="0"
                cy="0"
                rx="150"
                ry="52"
                fill="none"
                stroke="rgba(255,255,255,0.10)"
                strokeWidth="1"
                transform="rotate(-18)"
              />
              <ellipse
                cx="0"
                cy="0"
                rx="150"
                ry="52"
                fill="none"
                stroke="url(#globe-orbit)"
                strokeWidth="1.2"
                className="globe-orbit-sweep"
                transform="rotate(-18)"
              />
            </g>
            <g className="globe-spin-rev">
              <ellipse
                cx="0"
                cy="0"
                rx="160"
                ry="42"
                fill="none"
                stroke="rgba(255,255,255,0.07)"
                strokeWidth="1"
                transform="rotate(28)"
              />
              <ellipse
                cx="0"
                cy="0"
                rx="160"
                ry="42"
                fill="none"
                stroke="url(#globe-orbit)"
                strokeWidth="1"
                className="globe-orbit-sweep-2"
                transform="rotate(28)"
              />
            </g>
          </g>

          {/* Sphere */}
          <g>
            <ellipse
              cx="200"
              cy="338"
              rx="80"
              ry="10"
              fill="#2F7AE5"
              fillOpacity="0.18"
              filter="url(#globe-strong)"
            />
            <circle cx="200" cy="200" r="120" fill="url(#globe-sphere)" />
            <circle
              cx="200"
              cy="200"
              r="120"
              fill="none"
              stroke="rgba(255,255,255,0.14)"
              strokeWidth="1"
            />

            {/* Meridians + parallels */}
            <g
              clipPath="url(#globe-clip)"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
              className="globe-meridian-pulse globe-meridians"
            >
              <g className="globe-spin-slow">
                <ellipse cx="200" cy="200" rx="35" ry="120" />
                <ellipse cx="200" cy="200" rx="70" ry="120" />
                <ellipse cx="200" cy="200" rx="105" ry="120" />
                <line x1="200" y1="80" x2="200" y2="320" />
              </g>
              <line x1="80" y1="200" x2="320" y2="200" />
              <path d="M 84 170 Q 200 156 316 170" />
              <path d="M 84 230 Q 200 244 316 230" />
              <path d="M 96 140 Q 200 124 304 140" />
              <path d="M 96 260 Q 200 276 304 260" />
              <path d="M 118 110 Q 200 96 282 110" />
              <path d="M 118 290 Q 200 304 282 290" />
            </g>

            {/* Continents (abstract) */}
            <g
              clipPath="url(#globe-clip)"
              fill="#2F7AE5"
              fillOpacity="0.28"
            >
              <g
                className="globe-spin-slow"
                style={{ transformOrigin: '200px 200px' }}
              >
                <path d="M 140 170 C 148 154, 178 150, 190 166 C 202 182, 188 200, 172 204 C 154 208, 132 192, 140 170 Z" />
                <path d="M 200 150 C 218 146, 240 158, 238 174 C 236 188, 220 194, 208 188 C 198 182, 192 166, 200 150 Z" />
                <path d="M 214 220 C 232 218, 256 230, 250 246 C 244 258, 224 262, 214 252 C 206 244, 204 226, 214 220 Z" />
                <path d="M 140 226 C 156 220, 178 228, 180 240 C 182 252, 168 260, 154 256 C 142 252, 130 236, 140 226 Z" />
                <path d="M 178 106 C 188 100, 206 104, 210 114 C 214 124, 200 130, 190 126 C 182 122, 172 114, 178 106 Z" />
              </g>
            </g>

            {/* Pulse pings */}
            <g clipPath="url(#globe-clip)">
              <circle cx="168" cy="180" r="2" fill="#6FA7F5" />
              <circle
                cx="168"
                cy="180"
                r="2"
                fill="#6FA7F5"
                className="globe-ping"
              />
              <circle cx="230" cy="168" r="2" fill="#6FA7F5" />
              <circle
                cx="230"
                cy="168"
                r="2"
                fill="#6FA7F5"
                className="globe-ping"
                style={{ animationDelay: '-0.9s' }}
              />
              <circle cx="210" cy="238" r="2" fill="#B48BFF" />
              <circle
                cx="210"
                cy="238"
                r="2"
                fill="#B48BFF"
                className="globe-ping"
                style={{ animationDelay: '-1.6s' }}
              />
              <circle cx="156" cy="232" r="2" fill="#6FA7F5" />
              <circle
                cx="156"
                cy="232"
                r="2"
                fill="#6FA7F5"
                className="globe-ping"
                style={{ animationDelay: '-2.1s' }}
              />
            </g>

            {/* Highlight gloss */}
            <ellipse
              cx="170"
              cy="156"
              rx="42"
              ry="22"
              fill="#FFFFFF"
              fillOpacity="0.10"
              filter="url(#globe-soft)"
            />

            {/* Equator */}
            <ellipse
              cx="200"
              cy="200"
              rx="120"
              ry="6"
              fill="none"
              stroke="rgba(47,122,229,0.55)"
              strokeWidth="1"
              strokeDasharray="3 5"
            />
          </g>

          {/* Satellite nodes */}
          <g>
            <g transform="translate(84 104)">
              <circle r="8" fill="rgba(47,122,229,0.15)" />
              <circle r="3.5" fill="#2F7AE5" className="globe-node-glow" />
            </g>
            <g transform="translate(316 120)">
              <circle r="8" fill="rgba(180,139,255,0.15)" />
              <circle
                r="3.5"
                fill="#B48BFF"
                className="globe-node-glow"
                style={{ animationDelay: '-0.7s' }}
              />
            </g>
            <g transform="translate(310 298)">
              <circle r="8" fill="rgba(111,167,245,0.15)" />
              <circle
                r="3.5"
                fill="#6FA7F5"
                className="globe-node-glow"
                style={{ animationDelay: '-1.4s' }}
              />
            </g>
            <g transform="translate(90 288)">
              <circle r="8" fill="rgba(47,122,229,0.15)" />
              <circle
                r="3.5"
                fill="#2F7AE5"
                className="globe-node-glow"
                style={{ animationDelay: '-1s' }}
              />
            </g>
          </g>
        </svg>
      </div>
      {(caption || detail) && (
        <div className="relative z-10 mt-2 flex flex-col items-center">
          {caption && (
            <div className="t-secondary text-body mb-2">{caption}</div>
          )}
          <div
            className="relative w-[180px] h-[3px] rounded-full overflow-hidden globe-track"
            aria-hidden="true"
          >
            <div className="globe-indet" style={{ height: 3 }} />
          </div>
          {detail && (
            <div className="t-tertiary text-meta font-mono mt-2">{detail}</div>
          )}
        </div>
      )}
    </div>
  );
};
