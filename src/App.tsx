import { PopupShell } from './shell/PopupShell';
import { SettingsShell } from './settings/SettingsShell';

const windowKind = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('window') ?? 'popup';
};

export default function App() {
  return windowKind() === 'settings' ? <SettingsShell /> : <PopupShell />;
}
