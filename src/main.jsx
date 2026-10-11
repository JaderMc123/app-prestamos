import { render } from 'preact';
import { App } from './app.jsx';
import { initSession } from './lib/session.js';
import { initOutbox } from './lib/outbox.js';
import { initNative } from './lib/native.js';
import { logError } from './lib/api.js';

// Punto de entrada: arranca la sesión, la cola sin señal y las funciones del teléfono
initSession();
initOutbox();
initNative();

window.addEventListener('error', (e) => logError(e.error || e.message, { where: 'window' }));
window.addEventListener('unhandledrejection', (e) => logError(e.reason, { where: 'promise' }));

render(<App />, document.getElementById('app'));
