import { type RefObject } from 'react';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { IconButton } from '../../shared/ui/IconButton';
import { Kbd } from '../../shared/ui/Kbd';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { Select } from '../../shared/ui/Select';
import { Spinner } from '../../shared/ui/Spinner';
import { CloseIcon, SpeakerIcon, SwapIcon } from '../../shared/ui/icons';
import { TARGET_LANGUAGES, isRtl, languageLabel } from './languages';
import { MAX_CHARS, WARN_CHARS } from './translator.constants';

interface TranslatorComposerProps {
  sourceRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraftChange: (next: string) => void;
  target: string;
  onTargetChange: (code: string) => void;
  sourceHint: string | null;
  detectedFrom: string | null;
  liveTranslation: string | null;
  liveTo: string | null;
  isBusy: boolean;
  canSwap: boolean;
  onSwap: () => void;
  onClearDraft: () => void;
  onCopy: (text: string) => void;
  onSpeak: (text: string, lang: string) => void;
  onTranslateNow: () => void;
}

/// Header (from / swap / to) + dual-pane composer (source | target).
/// Pure presentation — state and side-effects live in TranslatorShell.
export const TranslatorComposer = ({
  sourceRef,
  draft,
  onDraftChange,
  target,
  onTargetChange,
  sourceHint,
  detectedFrom,
  liveTranslation,
  liveTo,
  isBusy,
  canSwap,
  onSwap,
  onClearDraft,
  onCopy,
  onSpeak,
  onTranslateNow,
}: TranslatorComposerProps) => {
  const isCharsOver = draft.length > MAX_CHARS;
  const isCharsWarn = draft.length > WARN_CHARS && !isCharsOver;
  const fromLabel = detectedFrom
    ? languageLabel(detectedFrom)
    : sourceHint
      ? languageLabel(sourceHint)
      : 'Auto-detect';
  const toLabel = languageLabel(target);
  const hasDraft = draft.trim().length > 0;
  const hasLiveResult = liveTranslation !== null;

  return (
    <>
      <div className="px-3 pt-3 pb-2 flex items-center gap-2 shrink-0">
        <div className="flex-1 flex items-center gap-1.5 min-w-0">
          <span className="t-tertiary text-meta">From</span>
          <span
            className={`text-meta font-medium truncate ${detectedFrom ? '' : 't-secondary'}`}
            style={detectedFrom ? { color: 'var(--stash-accent)' } : undefined}
          >
            {fromLabel}
          </span>
        </div>
        <IconButton
          onClick={onSwap}
          title={canSwap ? 'Swap languages (⌘⇧S)' : 'Swap unavailable for auto-detect'}
          stopPropagation={false}
        >
          <SwapIcon size={13} className={canSwap ? '' : 'opacity-40'} />
        </IconButton>
        <div className="flex items-center gap-1.5">
          <span className="t-tertiary text-meta">To</span>
          <Select
            label="Target language"
            value={target}
            onChange={onTargetChange}
            options={TARGET_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
          />
        </div>
      </div>

      <div className="mx-3 mb-2 grid grid-cols-2 gap-2 shrink-0">
        <Card padding="sm" rounded="lg" className="flex flex-col min-h-[120px]">
          <div className="flex items-center justify-between mb-1">
            <SectionLabel>{fromLabel}</SectionLabel>
            {hasDraft && (
              <button
                type="button"
                onClick={onClearDraft}
                className="t-tertiary hover:t-primary text-meta ring-focus rounded"
                title="Clear (Esc)"
                aria-label="Clear source"
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
          <textarea
            ref={sourceRef}
            aria-label="Text to translate"
            value={draft}
            onChange={(e) => onDraftChange(e.currentTarget.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                onTranslateNow();
              }
            }}
            dir={isRtl(detectedFrom ?? sourceHint) ? 'rtl' : 'auto'}
            placeholder="Paste or type — auto-translates"
            rows={4}
            maxLength={MAX_CHARS + 200}
            className="bg-transparent outline-none resize-none t-primary text-body leading-snug flex-1"
          />
          <div className="flex items-center justify-between mt-1">
            <span
              className={`text-meta ${
                isCharsOver || isCharsWarn ? '' : 't-tertiary'
              }`}
              style={
                isCharsOver
                  ? { color: 'var(--color-danger-fg)' }
                  : isCharsWarn
                    ? { color: 'var(--color-warning-fg)' }
                    : undefined
              }
            >
              {hasDraft
                ? `${draft.length.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`
                : ''}
            </span>
            {hasDraft && (
              <IconButton
                onClick={() => onSpeak(draft, sourceHint ?? detectedFrom ?? 'en')}
                title="Listen to source"
                stopPropagation={false}
              >
                <SpeakerIcon size={12} />
              </IconButton>
            )}
          </div>
        </Card>

        <Card
          padding="sm"
          rounded="lg"
          tone={hasLiveResult ? 'accent' : 'neutral'}
          className="flex flex-col min-h-[120px] relative"
        >
          <div className="flex items-center justify-between mb-1">
            <SectionLabel>{toLabel}</SectionLabel>
            {isBusy && <Spinner size={11} />}
          </div>
          <div
            className="flex-1 t-primary text-body leading-snug break-words overflow-y-auto nice-scroll"
            dir={isRtl(target) ? 'rtl' : 'auto'}
            aria-live="polite"
          >
            {liveTranslation ?? (
              <span className="t-tertiary">
                {isBusy ? 'Translating…' : 'Translation appears here'}
              </span>
            )}
          </div>
          {hasLiveResult && liveTo && (
            <div className="flex items-center justify-end gap-1 mt-1">
              <IconButton
                onClick={() => onSpeak(liveTranslation ?? '', liveTo)}
                title="Listen"
                stopPropagation={false}
              >
                <SpeakerIcon size={12} />
              </IconButton>
              <Button
                size="xs"
                variant="soft"
                tone="accent"
                onClick={() => onCopy(liveTranslation ?? '')}
                title="Copy translation"
              >
                Copy
              </Button>
            </div>
          )}
        </Card>
      </div>

      <div className="px-3 pb-2 flex items-center justify-between text-meta t-tertiary shrink-0">
        <span className="flex items-center gap-1.5">
          <Kbd>⌘K</Kbd> focus
          <Kbd>⌘↵</Kbd> translate
          {canSwap && (
            <>
              <Kbd>⌘⇧S</Kbd> swap
            </>
          )}
        </span>
        {isBusy ? <span>Working…</span> : null}
      </div>
    </>
  );
};
