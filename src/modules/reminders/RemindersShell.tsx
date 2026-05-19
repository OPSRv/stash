import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../../shared/ui/Button';
import { IconButton } from '../../shared/ui/IconButton';
import { EmptyState } from '../../shared/ui/EmptyState';
import { CenterSpinner } from '../../shared/ui/CenterSpinner';
import { Spinner } from '../../shared/ui/Spinner';
import { useToast } from '../../shared/ui/Toast';
import { PrevIcon, NextIcon, TrashIcon, PlusIcon } from '../../shared/ui/icons';
import { accent } from '../../shared/theme/accent';
import {
  remindersCancel,
  remindersCreate,
  remindersList,
  remindersListRange,
  type Reminder,
} from './api';
import { CreateReminderModal } from './CreateReminderModal';
import './reminders.css';

/// Top-level Reminders module. One screen, two panes: a month grid on
/// the left (heroes the time-as-data feeling) and an "active list" on
/// the right that defaults to "upcoming" but switches to "selected
/// day" when the user clicks a calendar cell. Everything routes
/// through the same Rust repo `/remind`, the LLM tools, and (later)
/// the Google Calendar sync share — so the UI is a thin face onto an
/// already-battle-tested service.
export const RemindersShell = () => {
  const { toast } = useToast();

  // Authoritative list (active only). The right pane reads from this
  // when no calendar cell is selected. Loaded on mount + refreshed
  // whenever the backend emits `reminders:changed`.
  const [active, setActive] = useState<Reminder[]>([]);
  // Calendar-pane data, sliced to the visible month + extended into
  // adjacent weeks so cells from the previous/next month still show
  // a dot when relevant. Separate from `active` because it includes
  // sent / cancelled rows for the grid dimming.
  const [monthRows, setMonthRows] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  // Current visible month — first day of the month at local-midnight.
  // We anchor on the user's tz so "today" lines up with the calendar
  // cell the user actually expects.
  const [visibleMonth, setVisibleMonth] = useState<Date>(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  // Selected calendar cell, or null = show upcoming list.
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelling, setCancelling] = useState<number | null>(null);

  const refreshActive = useCallback(async () => {
    try {
      const rows = await remindersList();
      setActive(rows);
    } catch (e) {
      toast({
        title: 'Failed to load reminders',
        description: String(e),
        variant: 'error',
      });
    }
  }, [toast]);

  const refreshMonth = useCallback(async () => {
    const gridStart = startOfCalendarGrid(visibleMonth);
    const gridEnd = endOfCalendarGrid(visibleMonth);
    try {
      const rows = await remindersListRange(
        Math.floor(gridStart.getTime() / 1000),
        Math.floor(gridEnd.getTime() / 1000),
      );
      setMonthRows(rows);
    } catch (e) {
      toast({
        title: 'Failed to load month',
        description: String(e),
        variant: 'error',
      });
    }
  }, [visibleMonth, toast]);

  // Initial load — fire both calls in parallel and clear `loading`
  // once both are settled so the spinner doesn't flash twice.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([refreshActive(), refreshMonth()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshActive, refreshMonth]);

  // Live updates: any create / cancel / fire on the backend emits
  // `reminders:changed`. Refresh both panes silently — no spinner so
  // the user sees the change as an in-place mutation, not a reload.
  useEffect(() => {
    const unlisten = listen('reminders:changed', () => {
      void refreshActive();
      void refreshMonth();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshActive, refreshMonth]);

  const onPrevMonth = () =>
    setVisibleMonth((m) => {
      const next = new Date(m);
      next.setMonth(next.getMonth() - 1);
      return next;
    });
  const onNextMonth = () =>
    setVisibleMonth((m) => {
      const next = new Date(m);
      next.setMonth(next.getMonth() + 1);
      return next;
    });
  const onToday = () => {
    const now = new Date();
    const month = new Date(now);
    month.setDate(1);
    month.setHours(0, 0, 0, 0);
    setVisibleMonth(month);
    setSelectedDay(startOfDay(now));
  };

  const onCreate = useCallback(
    async (text: string, when: string) => {
      try {
        await remindersCreate(text, when);
        toast({
          title: 'Reminder scheduled',
          description: text,
          variant: 'success',
        });
        setCreateOpen(false);
      } catch (e) {
        toast({
          title: 'Could not schedule reminder',
          description: String(e),
          variant: 'error',
        });
        throw e; // re-raise so the modal keeps focus and shows the error
      }
    },
    [toast],
  );

  const onCancel = useCallback(
    async (id: number) => {
      setCancelling(id);
      try {
        const removed = await remindersCancel(id);
        if (!removed) {
          toast({
            title: 'Already fired',
            description: 'This reminder is no longer active.',
          });
        }
      } catch (e) {
        toast({
          title: 'Could not cancel',
          description: String(e),
          variant: 'error',
        });
      } finally {
        setCancelling(null);
      }
    },
    [toast],
  );

  // Calendar bucketing — group rows by YYYY-MM-DD in the user's tz so
  // a single hit-test in the grid is O(1).
  const cellMap = useMemo(() => {
    const m = new Map<string, Reminder[]>();
    for (const r of monthRows) {
      const k = dayKey(new Date(r.due_at * 1000));
      const arr = m.get(k);
      if (arr) arr.push(r);
      else m.set(k, [r]);
    }
    return m;
  }, [monthRows]);

  const days = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const monthLabel = useMemo(
    () =>
      visibleMonth.toLocaleString(undefined, {
        month: 'long',
        year: 'numeric',
      }),
    [visibleMonth],
  );

  // Right-pane content. When a day is selected, show that day's
  // reminders (active only). Otherwise show the next 12 upcoming.
  const listRows = useMemo<Reminder[]>(() => {
    if (selectedDay) {
      const start = selectedDay.getTime() / 1000;
      const end = (selectedDay.getTime() + 86_400_000) / 1000;
      return active.filter((r) => r.due_at >= start && r.due_at < end);
    }
    return active.slice(0, 12);
  }, [selectedDay, active]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-2 border-b [border-color:var(--hairline)]">
        <div className="flex items-center gap-1">
          <IconButton title="Previous month" onClick={onPrevMonth}>
            <PrevIcon size={14} />
          </IconButton>
          <IconButton title="Next month" onClick={onNextMonth}>
            <NextIcon size={14} />
          </IconButton>
        </div>
        <div className="text-title font-semibold t-primary capitalize tabular-nums">
          {monthLabel}
        </div>
        <button
          type="button"
          onClick={onToday}
          className="text-meta rounded px-2 py-0.5 border [border-color:var(--hairline)] hover:[background:rgba(255,255,255,0.04)] transition-colors t-secondary"
        >
          Today
        </button>
        <div className="flex-1" />
        <Button
          size="xs"
          variant="soft"
          tone="accent"
          onClick={() => setCreateOpen(true)}
          leadingIcon={<PlusIcon size={12} />}
        >
          New reminder
        </Button>
      </header>
      {loading ? (
        <CenterSpinner />
      ) : (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <CalendarPane
            days={days}
            visibleMonth={visibleMonth}
            cellMap={cellMap}
            selectedDay={selectedDay}
            onSelectDay={(d) =>
              setSelectedDay((prev) =>
                prev && sameDay(prev, d) ? null : d,
              )
            }
          />
          <ListPane
            rows={listRows}
            selectedDay={selectedDay}
            cancellingId={cancelling}
            onCancel={onCancel}
            onClearSelection={() => setSelectedDay(null)}
            onAdd={() => setCreateOpen(true)}
          />
        </div>
      )}
      <CreateReminderModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={onCreate}
        defaultDay={selectedDay}
      />
    </div>
  );
};

// ─── Calendar pane ────────────────────────────────────────────────

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface CalendarPaneProps {
  days: Date[];
  visibleMonth: Date;
  cellMap: Map<string, Reminder[]>;
  selectedDay: Date | null;
  onSelectDay: (d: Date) => void;
}

const CalendarPane = ({
  days,
  visibleMonth,
  cellMap,
  selectedDay,
  onSelectDay,
}: CalendarPaneProps) => {
  const today = startOfDay(new Date());
  return (
    <div className="flex flex-col flex-1 min-w-0 border-r [border-color:var(--hairline)]">
      <div className="grid grid-cols-7 px-3 pt-2 pb-1 text-meta t-tertiary uppercase tracking-wider">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="text-center select-none">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 grid-rows-6 flex-1 min-h-0 px-3 pb-3 gap-1">
        {days.map((d) => {
          const inMonth = d.getMonth() === visibleMonth.getMonth();
          const isToday = sameDay(d, today);
          const isSelected = selectedDay !== null && sameDay(d, selectedDay);
          const rows = cellMap.get(dayKey(d)) ?? [];
          const activeCount = rows.filter((r) => !r.sent && !r.cancelled).length;
          const hasAny = rows.length > 0;
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onSelectDay(d)}
              className="stash-rem-cell"
              data-in-month={inMonth ? 'true' : 'false'}
              data-today={isToday ? 'true' : 'false'}
              data-selected={isSelected ? 'true' : 'false'}
              data-has-reminders={activeCount > 0 ? 'true' : 'false'}
              style={isSelected ? { background: accent(0.18), borderColor: accent(0.4) } : undefined}
            >
              <span className="stash-rem-cell-day tabular-nums">{d.getDate()}</span>
              {hasAny && (
                <span
                  className="stash-rem-cell-count tabular-nums"
                  title={`${activeCount} active · ${rows.length - activeCount} past`}
                >
                  {activeCount > 0 ? activeCount : '·'}
                </span>
              )}
              {activeCount > 0 && (
                <span
                  aria-hidden
                  className="stash-rem-cell-dot"
                  style={{ background: accent(0.85) }}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ─── List pane ────────────────────────────────────────────────────

interface ListPaneProps {
  rows: Reminder[];
  selectedDay: Date | null;
  cancellingId: number | null;
  onCancel: (id: number) => void;
  onClearSelection: () => void;
  onAdd: () => void;
}

const ListPane = ({
  rows,
  selectedDay,
  cancellingId,
  onCancel,
  onClearSelection,
  onAdd,
}: ListPaneProps) => {
  const heading = selectedDay
    ? selectedDay.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      })
    : 'Upcoming';
  return (
    <div className="flex flex-col w-[300px] shrink-0 min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b [border-color:var(--hairline)]">
        <div className="text-body t-primary font-medium capitalize truncate" title={heading}>
          {heading}
        </div>
        {selectedDay && (
          <button
            type="button"
            onClick={onClearSelection}
            className="text-meta t-tertiary hover:t-primary transition-colors"
            title="Show upcoming instead"
          >
            clear
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <EmptyState
            title={selectedDay ? 'No reminders this day' : 'No upcoming reminders'}
            description={
              selectedDay
                ? 'Pick a different day or add one for this date.'
                : 'Schedule one with the button above, or send /remind in Telegram.'
            }
            action={
              <Button size="xs" variant="soft" tone="accent" onClick={onAdd}>
                Add reminder
              </Button>
            }
          />
        ) : (
          <ul className="divide-y [&>li]:[border-color:var(--hairline)]">
            {rows.map((r) => (
              <ReminderRow
                key={r.id}
                row={r}
                cancelling={cancellingId === r.id}
                showFullDate={!selectedDay}
                onCancel={() => onCancel(r.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

interface ReminderRowProps {
  row: Reminder;
  cancelling: boolean;
  showFullDate: boolean;
  onCancel: () => void;
}

const ReminderRow = ({ row, cancelling, showFullDate, onCancel }: ReminderRowProps) => {
  const due = new Date(row.due_at * 1000);
  const time = due.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const datePart = showFullDate
    ? due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;
  const now = Date.now();
  const isImminent = row.due_at * 1000 - now < 60 * 60 * 1000;
  return (
    <li className="group flex items-center gap-2 px-3 py-2 hover:[background:rgba(255,255,255,0.025)]">
      <div className="flex flex-col items-end shrink-0 w-14 tabular-nums">
        {datePart && (
          <span className="text-meta t-tertiary uppercase tracking-wider">
            {datePart}
          </span>
        )}
        <span
          className="text-body font-medium tabular-nums"
          style={{
            color: isImminent ? 'rgb(var(--stash-accent-rgb))' : undefined,
          }}
        >
          {time}
        </span>
      </div>
      <div className="text-body t-primary flex-1 min-w-0 truncate" title={row.text}>
        {row.text}
      </div>
      <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
        <IconButton title="Cancel reminder" onClick={onCancel} disabled={cancelling}>
          {cancelling ? <Spinner size={12} /> : <TrashIcon size={12} />}
        </IconButton>
      </div>
    </li>
  );
};

// ─── date helpers ─────────────────────────────────────────────────

const startOfDay = (d: Date): Date => {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
};
const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();
const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d
    .getDate()
    .toString()
    .padStart(2, '0')}`;

/// Compute the 42-cell calendar grid for the given month, starting on
/// Monday. We always render 6 rows so the layout doesn't jiggle when
/// the user pages across months of different lengths.
const buildCalendarDays = (monthAnchor: Date): Date[] => {
  const start = new Date(monthAnchor);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  // JS `getDay()` is Sun=0..Sat=6 — we want Mon=0..Sun=6 to align
  // with how the Stash UI labels columns. The remap below is the
  // ISO-week-day shift.
  const isoDow = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - isoDow);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  return days;
};

const startOfCalendarGrid = (monthAnchor: Date): Date => {
  const grid = buildCalendarDays(monthAnchor);
  return grid[0];
};

const endOfCalendarGrid = (monthAnchor: Date): Date => {
  const grid = buildCalendarDays(monthAnchor);
  const last = grid[grid.length - 1];
  const out = new Date(last);
  out.setDate(out.getDate() + 1);
  return out;
};
