import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Input } from '../../shared/ui/Input';
import { Modal } from '../../shared/ui/Modal';
import { accent } from '../../shared/theme/accent';

interface Props {
  open: boolean;
  onClose: () => void;
  /// Returns a Promise — if it rejects the modal stays open and the
  /// shell shows the error toast. Resolves on success and the parent
  /// closes us.
  onSubmit: (text: string, when: string) => Promise<void>;
  /// If the user has a day selected in the calendar pane, we default
  /// the date side of the `when` field to that date so the modal
  /// inherits the user's current focus instead of reverting to "today".
  defaultDay: Date | null;
}

/// Pre-baked time slots the user can drop into the `when` field with
/// one click. Grouped by category so the row stays scannable instead
/// of being one long ribbon.
const QUICK_CHIPS: { label: string; value: string }[] = [
  { label: '10 min', value: '10m' },
  { label: '30 min', value: '30m' },
  { label: '1 hour', value: '1h' },
  { label: '3 hours', value: '3h' },
  { label: '9:00', value: '09:00' },
  { label: '14:00', value: '14:00' },
  { label: '21:00', value: '21:00' },
  { label: 'Tomorrow 9:00', value: 'tomorrow 09:00' },
];

export const CreateReminderModal = ({ open, onClose, onSubmit, defaultDay }: Props) => {
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textRef = useRef<HTMLInputElement | null>(null);

  // Pre-fill `when` with the selected day (YYYY-MM-DD) once the modal
  // opens, so a user who picked May 25 in the calendar doesn't have
  // to retype the date. We leave the time empty so they can choose.
  useEffect(() => {
    if (!open) return;
    setText('');
    if (defaultDay) {
      const d = defaultDay;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      // Don't bother prefixing today's date — bare "HH:MM" already
      // means "today, or tomorrow if past" in the parser. Only inject
      // the YYYY-MM-DD when the user has a non-today day selected.
      if (d.getTime() !== today.getTime()) {
        const ymd = `${d.getFullYear()}-${(d.getMonth() + 1)
          .toString()
          .padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
        setWhen(`${ymd} `);
      } else {
        setWhen('');
      }
    } else {
      setWhen('');
    }
    // Defer focus until the modal has actually painted; otherwise the
    // <input> isn't in the DOM yet and the call is a no-op.
    const t = window.setTimeout(() => textRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, defaultDay]);

  const canSubmit = useMemo(
    () => text.trim().length > 0 && when.trim().length > 0 && !submitting,
    [text, when, submitting],
  );

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(text.trim(), when.trim());
    } catch {
      // Parent toasted; keep modal open so user can correct + retry.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} ariaLabel="New reminder" maxWidth={460}>
      <div className="flex flex-col gap-3">
        <div className="text-title t-primary font-semibold">New reminder</div>
        <label className="flex flex-col gap-1">
          <span className="text-meta t-tertiary uppercase tracking-wider">
            What to remind you about
          </span>
          <Input
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Practice guitar"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-meta t-tertiary uppercase tracking-wider">When</span>
          <Input
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            placeholder="10m / 14:30 / tomorrow 9:00 / 2026-05-25 14:30"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_CHIPS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setWhen(c.value)}
              className="text-meta tabular-nums rounded px-2 py-1 border transition-colors"
              style={{
                background: when === c.value ? accent(0.18) : 'transparent',
                borderColor:
                  when === c.value ? accent(0.4) : 'var(--hairline)',
                color:
                  when === c.value
                    ? 'rgb(var(--stash-accent-rgb))'
                    : 'var(--text-secondary)',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button size="xs" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="xs"
            variant="soft"
            tone="accent"
            loading={submitting}
            disabled={!canSubmit}
            onClick={submit}
          >
            Schedule
          </Button>
        </div>
        <p className="text-meta t-tertiary leading-relaxed">
          Tip: ⌘⏎ to schedule. The same parser powers <code>/remind</code> in
          Telegram.
        </p>
      </div>
    </Modal>
  );
};
