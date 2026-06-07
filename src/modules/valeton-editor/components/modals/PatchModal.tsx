import { toggleCTL } from '../../lib/actions';
import { BLOCKS } from '../../lib/blocks';
import { useStore } from '../../store/store';
import { Modal } from '../ui/Modal';

const CTL_ORDER = [0, 1, 2, 9, 3, 4, 5, 6, 7, 8];

export const PatchModal = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => {
  const ctl = useStore((s) => s.ctl);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Patch Settings"
      dataId="patchModal"
      footer={
        <button type="button" className="btn btn-soft" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="mb-2 text-sm text-ve-dim">CTL</p>
      <div className="grid grid-cols-5 gap-2">
        {CTL_ORDER.map((b) => {
          const block = BLOCKS[b];
          const on = ctl[b];
          return (
            <button
              key={b}
              type="button"
              data-id={`${block.key}_ctl_btn`}
              className={`rounded-md border px-2 py-2 text-sm transition ${
                on
                  ? 'border-ve-accent text-white shadow-[0_0_12px_rgba(74,163,255,0.35)]'
                  : 've-pedal text-ve-dim'
              }`}
              style={
                on
                  ? {
                      background:
                        'linear-gradient(180deg,#57abff,var(--color-ve-accent-700))',
                    }
                  : undefined
              }
              onClick={() => toggleCTL(block.key, !on)}
            >
              {block.label}
            </button>
          );
        })}
      </div>
    </Modal>
  );
};
