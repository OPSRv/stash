import { Suspense, lazy } from 'react';
import { CenterSpinner } from '../../../../shared/ui/CenterSpinner';
import { Modal } from '../ui/Modal';

// Lazy so the tuner's mic + pitch-detection code stays out of the Valeton
// chunk until the modal is first opened (Performance — see CLAUDE.md). The
// Modal renders nothing while closed, so the chunk loads on first open.
const TunerShell = lazy(() =>
  import('../../../tuner/TunerShell').then((m) => ({ default: m.TunerShell })),
);

export const TunerModal = ({ open, onClose }: { open: boolean; onClose: () => void }) => (
  <Modal open={open} onClose={onClose} title="Tuner" dataId="tunerModal">
    <Suspense fallback={<CenterSpinner fit="inline" />}>
      <TunerShell />
    </Suspense>
  </Modal>
);
