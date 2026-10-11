import { render } from 'preact';
import { App } from './app.jsx';
import { initSession } from './lib/session.js';
import { initOutbox } from './lib/outbox.js';
import { initNative } from './lib/native.js';
import { logError } from './lib/api.js';
import { checkForUpdate } from './lib/update.js';

// Punto de entrada: primero revisa si hay versión nueva; luego arranca la sesión, la cola sin señal y el teléfono
window.addEventListener('error', (e) => logError(e.error || e.message, { where: 'window' }));
window.addEventListener('unhandledrejection', (e) => logError(e.reason, { where: 'promise' }));

checkForUpdate().then(() => {
  initSession();
  initOutbox();
  initNative();
  render(<App />, document.getElementById('app'));
});
