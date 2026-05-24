import {
  type ChangeEvent,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Button } from '../../../../shared/ui/Button';
import { IconButton } from '../../../../shared/ui/IconButton';
import { Textarea } from '../../../../shared/ui/Textarea';
import { CopyIcon, CheckIcon } from '../../../../shared/ui/icons';
import { copyText } from '../../../../shared/util/clipboard';
import {
  DEV_OPEN_TOOL_EVENT,
  takePendingDevTool,
} from '../../pendingTool';
import { decodeJwt } from './jwt';
import { JsonTree } from './JsonTree';

interface SectionProps {
  label: string;
  /// Decoded value to render in the tree. `null` means "section not
  /// applicable" (e.g. signature isn't JSON).
  value: unknown | null;
  /// Raw segment text used for the "Copy raw" button — JSON for
  /// header/payload, the base64url signature itself for the third.
  rawCopy: string;
  /// Optional empty-state hint when `value` is null but we still
  /// render the section (signature with `alg: none` etc.).
  emptyHint?: string;
}

const Section = ({ label, value, rawCopy, emptyHint }: SectionProps) => {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const ok = await copyText(rawCopy);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <section className="flex flex-col gap-2 min-h-0">
      <div className="flex items-center justify-between">
        <span className="text-meta t-tertiary uppercase tracking-wider">
          {label}
        </span>
        <IconButton
          onClick={onCopy}
          title={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
          tooltipSide="left"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </IconButton>
      </div>
      <div className="rounded-lg border hair p-2 bg-[color:var(--bg-elev)] overflow-auto nice-scroll max-h-[260px]">
        {value !== null ? (
          <JsonTree value={value} />
        ) : (
          <div className="font-mono text-meta t-secondary break-all whitespace-pre-wrap">
            {rawCopy || (
              <span className="t-tertiary italic">{emptyHint ?? '—'}</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

/// Pull a `token` field out of the pending-dev-tool slot, if it's
/// addressed to us. Defensive: the slot is shared across tools and
/// could carry any shape — we only honour ours.
const tokenFromPending = (): string | null => {
  const pending = takePendingDevTool();
  if (!pending || pending.toolId !== 'jwt') return null;
  const payload = pending.payload as { token?: unknown } | undefined;
  return typeof payload?.token === 'string' ? payload.token : null;
};

export function JwtTool() {
  // Initial seed: pick up a clipboard JWT the shell parked for us, if
  // any. We deliberately don't ship a demo token — secret scanners
  // (GitGuardian) flag the RFC 7519 example as a JWT incident on
  // every commit, and the textarea placeholder already explains the
  // expected format.
  const [token, setToken] = useState<string>(() => tokenFromPending() ?? '');

  // Live updates: when the tool is *already* mounted and the user
  // copies another JWT, the shell fires `stash:dev-open-tool` with the
  // new token. Pick it up and refresh the textarea.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { toolId?: string; payload?: { token?: unknown } }
        | undefined;
      if (!detail || detail.toolId !== 'jwt') return;
      const next = detail.payload?.token;
      if (typeof next === 'string' && next.trim()) setToken(next);
    };
    window.addEventListener(DEV_OPEN_TOOL_EVENT, handler);
    return () => window.removeEventListener(DEV_OPEN_TOOL_EVENT, handler);
  }, []);

  const result = useMemo(() => decodeJwt(token), [token]);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setToken(e.target.value);
  };

  return (
    <div className="flex flex-col gap-4 p-4 min-h-full">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-meta t-tertiary uppercase tracking-wider">
            JWT token
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setToken('')}
            disabled={!token}
          >
            Clear
          </Button>
        </div>
        <Textarea
          value={token}
          onChange={handleChange}
          spellCheck={false}
          rows={4}
          className="font-mono text-meta"
          placeholder="Paste header.payload.signature here"
          invalid={!result.ok && token.trim().length > 0}
          aria-label="JWT token"
        />
        {!result.ok && token.trim().length > 0 && (
          <p
            role="alert"
            className="text-meta text-[color:var(--color-danger-fg)]"
          >
            {result.error}
          </p>
        )}
      </section>

      {result.ok && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-h-0">
          <Section
            label="Header"
            value={result.decoded.header}
            rawCopy={result.decoded.raw.header}
          />
          <Section
            label="Payload"
            value={result.decoded.payload}
            rawCopy={result.decoded.raw.payload}
          />
          <div className="md:col-span-2">
            <Section
              label="Signature"
              value={null}
              rawCopy={result.decoded.signature}
              emptyHint="No signature (alg: none)"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default JwtTool;
