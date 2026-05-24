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
import { decodeJwt, stripBearer } from './jwt';
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
  /// Algorithm pulled from the header — rendered as a small badge next
  /// to the label. Only meaningful for the Header card.
  alg?: string | null;
}

const Section = ({ label, value, rawCopy, emptyHint, alg }: SectionProps) => {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const ok = await copyText(rawCopy);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <section className="rounded-xl border hair bg-[color:var(--bg-elev)] overflow-hidden">
      <header className="flex items-center justify-between px-3 py-2 border-b hair bg-[color:var(--bg-hover)]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-meta t-tertiary uppercase tracking-wider">
            {label}
          </span>
          {alg && (
            <span
              className="text-meta px-1.5 py-0.5 rounded border hair t-secondary tabular-nums"
              title="Signing algorithm (header.alg)"
            >
              {alg}
            </span>
          )}
        </div>
        <IconButton
          onClick={onCopy}
          title={copied ? 'Copied' : `Copy raw ${label.toLowerCase()}`}
          tooltipSide="left"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </IconButton>
      </header>
      <div className="p-3">
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

/// Surface the signing algorithm (`alg`) on the Header card when it's
/// a plain string. Defensive against tokens that put weird types
/// there — we just hide the badge in that case.
const algFromHeader = (header: unknown): string | null => {
  if (header && typeof header === 'object' && 'alg' in header) {
    const v = (header as { alg?: unknown }).alg;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
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

  // One-click clean-up: dedupe whitespace + strip a Bearer/Token
  // prefix the user may have pasted along with the token. Cheap to
  // expose; matches what the clipboard auto-open does for them
  // implicitly.
  const onClean = () => {
    const next = stripBearer(token);
    if (next !== token) setToken(next);
  };

  const tokenIsClean = stripBearer(token) === token.trim();
  const headerAlg = result.ok ? algFromHeader(result.decoded.header) : null;

  return (
    // Single scroll surface: the page below uses DevShell's outer
    // `overflow-auto`. We deliberately do NOT add our own scroll
    // container — nested scrollbars at the right edge looked awful.
    // The token textarea lives at the bottom in normal flow so it
    // never overlaps the decoded panes.
    <div className="flex flex-col gap-4 p-4 min-h-full">
      {result.ok && (
        <div className="flex flex-col gap-4">
          <Section
            label="Header"
            value={result.decoded.header}
            rawCopy={result.decoded.raw.header}
            alg={headerAlg}
          />
          <Section
            label="Payload"
            value={result.decoded.payload}
            rawCopy={result.decoded.raw.payload}
          />
          <Section
            label="Signature"
            value={null}
            rawCopy={result.decoded.signature}
            emptyHint="No signature (alg: none)"
          />
        </div>
      )}

      {!result.ok && token.trim().length > 0 && (
        <div
          role="alert"
          className="rounded-xl border hair p-3 text-meta text-[color:var(--color-danger-fg)]"
        >
          {result.error}
        </div>
      )}

      {!result.ok && token.trim().length === 0 && (
        <div className="rounded-xl border hair p-6 t-tertiary text-meta text-center">
          Paste a JWT below to decode it. <br />
          A <code className="font-mono">Bearer …</code> prefix is fine — we strip it for you.
        </div>
      )}

      <section className="rounded-xl border hair bg-[color:var(--bg-elev)] overflow-hidden">
        <header className="flex items-center justify-between px-3 py-2 border-b hair bg-[color:var(--bg-hover)]">
          <span className="text-meta t-tertiary uppercase tracking-wider">
            JWT token
          </span>
          <div className="flex items-center gap-1">
            {!tokenIsClean && token && (
              <Button
                size="xs"
                variant="ghost"
                onClick={onClean}
                title="Trim whitespace and strip a leading `Bearer ` / `Token ` prefix"
              >
                Clean
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setToken('')}
              disabled={!token}
            >
              Clear
            </Button>
          </div>
        </header>
        <div className="p-3">
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
        </div>
      </section>
    </div>
  );
}

export default JwtTool;
