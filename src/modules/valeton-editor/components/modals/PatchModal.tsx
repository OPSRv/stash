import { changePatchVol, toggleCTL } from '../../lib/actions';
import { BLOCKS } from '../../lib/blocks';
import { useStore } from '../../store/store';
import { Modal } from '../ui/Modal';

const CTL_ORDER = [0, 1, 2, 9, 3, 4, 5, 6, 7, 8];
const fill = (v: number, min: number, max: number) =>
  `${((v - min) / (max - min || 1)) * 100}%`;

export const PatchModal = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => {
  const patchVOL = useStore((s) => s.patchVOL);
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
      <div className="py-2">
        <input
          type="range"
          className="range"
          data-id="patch_vol_value"
          min={0}
          max={100}
          value={patchVOL}
          style={{ ['--_fill' as string]: fill(patchVOL, 0, 100) }}
          onChange={(e) => changePatchVol(Number(e.target.value))}
        />
        <div className="mt-0.5 flex items-center justify-between">
          <span className="field-label">Patch Vol</span>
          <span className="field-value" data-id="patch_vol_output">
            {patchVOL}
          </span>
        </div>
      </div>

      <hr className="my-3 border-ve-stroke" />
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
                  : 'border-ve-stroke bg-ve-bg-2 text-ve-dim'
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
