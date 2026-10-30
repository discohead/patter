import { createRoot } from 'react-dom/client';
import { app } from './app/store';
import { roleOf } from './app/role';
import { App } from './ui/App';
import './ui/styles.css';

// Whose page this is decides what loads (the host's library, or the broadcast), so it's settled first.
app.begin(await roleOf(window.location));
createRoot(document.getElementById('root')!).render(<App />);
