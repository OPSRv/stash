import { PopupShell } from './shell/PopupShell';
import { ToastProvider } from './shared/ui/Toast';
import { LiveRegionProvider } from './shared/ui/LiveRegion';
import { CameraPipWindow } from './modules/recorder/CameraPipWindow';

export default function App() {
  // The camera PIP window mounts React at the same entry and disambiguates
  // itself via URL hash so we don't need a router.
  if (window.location.hash === '#camera-pip') {
    return <CameraPipWindow />;
  }
  return (
    <LiveRegionProvider>
      <ToastProvider>
        <PopupShell />
      </ToastProvider>
    </LiveRegionProvider>
  );
}
