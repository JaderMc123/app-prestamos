import { rpc, isOffline, logError } from './api.js';
import { createStore } from './store.js';
import { takePending, uploadClientPhotos } from './images.js';

// Acá se guardan los cobros hechos sin señal y se envían cuando vuelve la conexión
const KEY = 'outbox.v1';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

function write(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {}
  outbox.set({ pending: items.length });
}

// failed: cobros que el servidor rechazó al sincronizar (se le muestran al cobrador)
export const outbox = createStore({ pending: read().length, syncing: false, failed: [] });

export const uuid = () =>
  crypto.randomUUID?.() ||
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

// Intenta enviar; si no hay señal, lo deja en cola. Devuelve { queued } para avisar al usuario
// after: tarea a ejecutar cuando el envío funcione (por ejemplo, subir las fotos de un cliente nuevo)
export async function send(fn, args, after = null) {
  try {
    const data = await rpc(fn, args);
    return { data, queued: false };
  } catch (err) {
    if (!isOffline(err)) throw err;
    write([...read(), { fn, args, after, at: Date.now() }]);
    return { data: null, queued: true };
  }
}

export async function flush() {
  if (outbox.get().syncing || !navigator.onLine) return;
  const items = read();
  if (!items.length) return;
  outbox.set({ syncing: true });
  const left = [];
  const failed = [];
  for (const item of items) {
    try {
      const data = await rpc(item.fn, item.args);
      if (item.after?.type === 'client-photos') {
        const photos = await takePending(item.after.key);
        if (photos) await uploadClientPhotos(item.after.orgId, data, photos);
      }
    } catch (err) {
      if (isOffline(err)) left.push(item);
      else {
        logError(err, { where: 'outbox', fn: item.fn });
        failed.push({ ...item, error: err.message });
      }
    }
  }
  write(left);
  outbox.set({ syncing: false, failed: [...outbox.get().failed, ...failed] });
}

export function initOutbox() {
  window.addEventListener('online', flush);
  flush();
}
