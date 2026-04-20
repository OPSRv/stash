import { EmptyState } from '../../shared/ui/EmptyState';

export const PomodoroShell = () => {
  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b hair">
        <h2 className="t-primary text-sm font-semibold">Pomodoro</h2>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <EmptyState title="Under construction" description="Sessions + presets coming next." />
      </div>
    </div>
  );
};
