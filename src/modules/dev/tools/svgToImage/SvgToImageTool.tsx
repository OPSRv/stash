import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '../../../../shared/ui/Button';
import { SegmentedControl } from '../../../../shared/ui/SegmentedControl';
import { Textarea } from '../../../../shared/ui/Textarea';

type Format = 'png' | 'jpg' | 'webp';
type Scale = 'auto' | '1' | '2' | '3' | '4';

const FORMAT_OPTIONS: ReadonlyArray<{ value: Format; label: string }> = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'webp', label: 'WebP' },
];

const SCALE_OPTIONS: ReadonlyArray<{ value: Scale; label: string; title?: string }> = [
  { value: 'auto', label: 'Auto', title: 'Native size declared in the SVG' },
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
  { value: '3', label: '3×' },
  { value: '4', label: '4×' },
];

const MIME: Record<Format, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

const DEFAULT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#22d3ee"/>
      <stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="84" height="84" rx="18" fill="url(#g)"/>
  <path d="M30 56 L46 40 L58 52 L70 36" fill="none" stroke="white" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

type ParsedSvg = {
  width: number;
  height: number;
  /// Normalised markup with `xmlns` injected when the source omitted it.
  source: string;
};

/// Pull width / height off the SVG root, falling back to the viewBox
/// when only one of the dimension attrs is present (common with
/// hand-authored SVGs and Figma exports). Returns `null` for empty
/// input or markup the browser parser couldn't make sense of.
export const parseSvg = (raw: string): ParsedSvg | { error: string } | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parser = new DOMParser();
  const doc = parser.parseFromString(trimmed, 'image/svg+xml');
  // DOMParser surfaces parse failures as a `<parsererror>` element in
  // the returned document rather than throwing, so we have to fish for
  // it explicitly.
  const errEl = doc.querySelector('parsererror');
  if (errEl) return { error: 'SVG markup could not be parsed.' };
  const svg = doc.documentElement;
  if (svg.tagName.toLowerCase() !== 'svg') {
    return { error: 'Root element must be <svg>.' };
  }
  const numAttr = (name: string): number => {
    const v = svg.getAttribute(name);
    if (!v) return 0;
    const m = v.match(/[-+]?\d*\.?\d+/);
    return m ? Number(m[0]) : 0;
  };
  let width = numAttr('width');
  let height = numAttr('height');
  const viewBox = svg.getAttribute('viewBox');
  if ((!width || !height) && viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      if (!width) width = parts[2];
      if (!height) height = parts[3];
    }
  }
  if (!width || !height) {
    width = width || 512;
    height = height || 512;
  }
  if (!svg.getAttribute('xmlns')) {
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  const source = new XMLSerializer().serializeToString(svg);
  return { width, height, source };
};

const resolveScale = (scale: Scale): number =>
  scale === 'auto' ? 1 : Number(scale);

const ext = (f: Format) => (f === 'jpg' ? 'jpg' : f);

export function SvgToImageTool() {
  const [source, setSource] = useState<string>(DEFAULT_SVG);
  const [format, setFormat] = useState<Format>('png');
  const [scale, setScale] = useState<Scale>('auto');
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  // Parse the source on every keystroke. Cheap (DOMParser is sync) and
  // gives the user immediate feedback when their paste breaks.
  const parsed = useMemo(() => parseSvg(source), [source]);
  const parsedSvg = parsed && !('error' in parsed) ? parsed : null;

  useEffect(() => {
    if (parsed && 'error' in parsed) {
      setError(parsed.error);
    } else {
      setError(null);
    }
  }, [parsed]);

  // Refresh the live preview whenever the parsed SVG changes. We
  // re-serialise via Blob/Image so the preview matches exactly what
  // the canvas pipeline will render — catches xmlns / namespace
  // issues that a literal `dangerouslySetInnerHTML` would mask.
  useEffect(() => {
    if (!parsedSvg) {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setPreviewUrl(null);
      return;
    }
    const blob = new Blob([parsedSvg.source], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = url;
    setPreviewUrl(url);
  }, [parsedSvg]);

  // Free the last preview Blob URL on unmount — leaving them attached
  // is a slow leak when the user opens/closes the tool repeatedly.
  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  const handleSourceChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setSource(e.target.value);
  };

  const download = useCallback(async () => {
    if (!parsedSvg) return;
    setDownloading(true);
    try {
      const factor = resolveScale(scale);
      const outW = Math.max(1, Math.round(parsedSvg.width * factor));
      const outH = Math.max(1, Math.round(parsedSvg.height * factor));

      const blob = new Blob([parsedSvg.source], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');
        // JPG has no alpha — fill a white background so transparency
        // doesn't render as black. PNG/WebP keep transparency intact.
        if (format === 'jpg') {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, outW, outH);
        }
        ctx.drawImage(img, 0, 0, outW, outH);

        const out = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), MIME[format], format === 'jpg' ? 0.92 : undefined),
        );
        if (!out) throw new Error('Browser could not encode the image.');
        const outUrl = URL.createObjectURL(out);
        try {
          const a = document.createElement('a');
          a.href = outUrl;
          a.download = `svg-export-${outW}x${outH}.${ext(format)}`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } finally {
          URL.revokeObjectURL(outUrl);
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }, [format, parsedSvg, scale]);

  const sizeLabel = parsedSvg
    ? (() => {
        const factor = resolveScale(scale);
        const w = Math.round(parsedSvg.width * factor);
        const h = Math.round(parsedSvg.height * factor);
        return `${w} × ${h}`;
      })()
    : '—';

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 min-h-full">
      <section className="flex flex-col gap-2 min-h-0">
        <div className="flex items-center justify-between">
          <span className="text-meta t-tertiary uppercase tracking-wider">
            SVG source
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setSource('')}
            disabled={!source}
          >
            Clear
          </Button>
        </div>
        <Textarea
          value={source}
          onChange={handleSourceChange}
          spellCheck={false}
          rows={16}
          className="font-mono text-meta min-h-[260px]"
          placeholder="Paste <svg>…</svg> here"
          invalid={!!error}
          aria-label="SVG source"
        />
        {error && (
          <p role="alert" className="text-meta text-[color:var(--color-danger-fg)]">
            {error}
          </p>
        )}
      </section>
      <section className="flex flex-col gap-3 min-h-0">
        <div className="flex flex-col gap-1.5">
          <span className="text-meta t-tertiary uppercase tracking-wider">
            Preview
          </span>
          <div
            className="rounded-lg border [border-color:var(--hairline)] flex items-center justify-center min-h-[200px] overflow-hidden"
            style={{
              background:
                'repeating-conic-gradient(rgba(255,255,255,0.04) 0% 25%, transparent 0% 50%) 0 0/16px 16px',
            }}
          >
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="SVG preview"
                className="max-w-full max-h-[260px]"
              />
            ) : (
              <span className="t-tertiary text-meta">
                No preview
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-meta t-tertiary uppercase tracking-wider">
            Format
          </span>
          <SegmentedControl
            options={FORMAT_OPTIONS}
            value={format}
            onChange={setFormat}
            size="sm"
            ariaLabel="Output format"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-meta t-tertiary uppercase tracking-wider">
            Scale
          </span>
          <SegmentedControl
            options={SCALE_OPTIONS}
            value={scale}
            onChange={setScale}
            size="sm"
            ariaLabel="Output scale"
          />
        </div>
        <div className="flex items-center justify-between mt-auto pt-2">
          <span className="t-tertiary text-meta">
            Output: <span className="t-secondary tabular-nums">{sizeLabel}</span>
          </span>
          <Button
            variant="solid"
            tone="accent"
            size="md"
            onClick={download}
            disabled={!parsedSvg}
            loading={downloading}
          >
            Download
          </Button>
        </div>
      </section>
    </div>
  );
}

export default SvgToImageTool;
