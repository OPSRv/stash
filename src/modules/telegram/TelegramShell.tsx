import { ConnectionPanel } from './sections/ConnectionPanel';

export function TelegramShell() {
  return (
    <div className="h-full overflow-auto">
      <ConnectionPanel />
    </div>
  );
}
