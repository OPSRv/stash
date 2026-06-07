import { useStore } from '../store/store';

export const StatusBar = () => {
  const statusText = useStore((s) => s.statusText);
  const connected = useStore((s) => s.connected);
  return (
    <div className="flex items-center gap-2 border-t border-ve-stroke-soft px-4 py-1.5 text-[0.78rem] text-ve-dim">
      <span className={`status-led ${connected ? 'on' : ''}`} />
      <span className="font-medium tracking-wide text-ve-faint uppercase">
        Status
      </span>
      <i className="truncate not-italic text-ve-dim" data-id="status_text">
        {statusText}
      </i>

      <div className="ml-auto flex items-center gap-3 whitespace-nowrap text-sm">
        <span className="font-semibold tracking-wide text-ve-dim">
          GP-5 Editor
        </span>
      </div>
    </div>
  );
};
