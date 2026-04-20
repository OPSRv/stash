import { PopupShell } from './shell/PopupShell';
import { ToastProvider } from './shared/ui/Toast';
import { LiveRegionProvider } from './shared/ui/LiveRegion';

export default function App() {
  return (
    <LiveRegionProvider>
      <ToastProvider>
        <PopupShell />
      </ToastProvider>
    </LiveRegionProvider>
  );
}
