import ReactDOM from 'react-dom/client';

import '../styles/tokens.css';
import { installContextMenuGuard } from '../shared/contextMenuGuard';
import { ToastProvider } from '../shared/ui/Toast';
import { VoicePopup } from './VoicePopup';

installContextMenuGuard(window);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <ToastProvider>
    <VoicePopup />
  </ToastProvider>,
);
