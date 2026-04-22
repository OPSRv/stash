import ReactDOM from 'react-dom/client';
import './styles/tokens.css';
import App from './App';
import { installContextMenuGuard } from './shared/contextMenuGuard';

installContextMenuGuard(window);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />);
