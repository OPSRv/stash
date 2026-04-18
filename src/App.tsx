import { DownloadsShell } from './modules/downloader/DownloadsShell';
import { PopupShell } from './shell/PopupShell';
import { SettingsShell } from './settings/SettingsShell';

const windowKind = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('window') ?? 'popup';
};

export default function App() {
  switch (windowKind()) {
    case 'settings':
      return <SettingsShell />;
    case 'downloads':
      return <DownloadsShell />;
    default:
      return <PopupShell />;
  }
}
