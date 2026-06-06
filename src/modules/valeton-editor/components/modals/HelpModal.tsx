import { Modal } from '../ui/Modal';

export const HelpModal = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => (
  <Modal
    open={open}
    onClose={onClose}
    title="Help"
    dataId="helpModal"
    footer={
      <button type="button" className="btn btn-soft" onClick={onClose}>
        Close
      </button>
    }
  >
    <div className="space-y-3 text-sm text-ve-text">
      <p>
        This is a web editor for the Valeton GP5. You have to use Chrome or
        another browser with Web Bluetooth / Web MIDI enabled (for iphone you
        can use BLUEFY), and a desktop or phone with bluetooth.
      </p>
      <p>You can use the keyboard to control some functions:</p>
      <ul className="list-disc space-y-1 pl-5 text-ve-dim">
        <li>
          On/off effects: 0 to 9 (you can use also Q W E R T Y U I O P with
          MVAVE Chocolate in Custom keyboard mode)
        </li>
        <li>Tap tempo: space</li>
        <li>Previous and next patches: pgUp, pgDown</li>
      </ul>
      <p>
        You can save the changes you make on the patch but it's only to the same
        patch you working on it. This is to prevent problems with the
        keybindings of tap tempo and effects.
      </p>
    </div>
  </Modal>
);
