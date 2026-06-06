import { useStore } from '../../store/store';
import { Modal } from '../ui/Modal';

/** Модалка синхронізації (BLE) — лишається відкритою до завершення синку. */
export const LoadModal = () => {
  const open = useStore((s) => s.loadModalOpen);
  const text = useStore((s) => s.loadStatusText);

  return (
    <Modal
      open={open}
      onClose={() => {}}
      staticBackdrop
      hideClose
      dataId="loadModal"
    >
      <div className="flex flex-col items-center gap-4 py-3 text-center">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-ve-stroke border-t-ve-accent" />
        <p>
          <i data-id="statusLoad">{text}</i>
        </p>
      </div>
    </Modal>
  );
};
