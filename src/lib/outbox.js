import { rpc, q, isOffline, logError } from './api.js';
import { supabase } from './supabase.js';
import { createStore } from './store.js';
import { session } from './session.js';
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

// Los rechazados también se guardan en el teléfono para que no se pierdan al cerrar la app
const FAILED_KEY = 'outbox.failed.v1';
function readFailed() {
  try {
    return JSON.parse(localStorage.getItem(FAILED_KEY)) || [];
  } catch {
    return [];
  }
}
function writeFailed(items) {
  try {
    localStorage.setItem(FAILED_KEY, JSON.stringify(items));
  } catch {}
  outbox.set({ failed: items });
}

// failed: cobros que el servidor rechazó al sincronizar (se le muestran al cobrador)
export const outbox = createStore({ pending: read().length, syncing: false, failed: readFailed() });

export const dismissFailed = () => writeFailed([]);

// Errores pasajeros (sin señal, sesión vencida, servidor ocupado): el registro se queda en cola y se reintenta
const retryable = (err) => isOffline(err) || /jwt|token|401|403|session|sesi[oó]n|timeout|tiempo|503|502|500|rate|SIN_CONEXION|NO_AUTENTICADO/i.test(`${err?.code || ''} ${err?.message || ''}`);

export const uuid = () =>
  crypto.randomUUID?.() ||
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

// Intenta enviar; si no hay señal, lo deja en cola. Devuelve { queued } para avisar al usuario
// after: tarea a ejecutar cuando el envío funcione (por ejemplo, subir las fotos de un cliente nuevo)
// Algunos registros se guardan directo en una tabla (ej. gastos); el código único evita duplicarlos al reintentar
async function exec(fn, args) {
  if (fn === 'insert_expense') {
    try {
      return await q(supabase.from('expenses').insert(args));
    } catch (err) {
      if (/duplicate|DUPLICADO/i.test(`${err.code} ${err.message}`)) return null;
      throw err;
    }
  }
  return rpc(fn, args);
}

export async function send(fn, args, after = null) {
  try {
    const data = await exec(fn, args);
    return { data, queued: false };
  } catch (err) {
    if (!isOffline(err)) throw err;
    write([...read(), { fn, args, after, at: Date.now(), uid: session.get().user?.id || null }]);
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
  const me = session.get().user?.id;
  if (!me) {
    outbox.set({ syncing: false });
    return;
  }
  for (const item of items) {
    // Cada registro se envía solo con la sesión de quien lo hizo
    if (item.uid && item.uid !== me) {
      left.push(item);
      continue;
    }
    try {
      const data = await exec(item.fn, item.args);
      if (item.after?.type === 'client-photos') {
        const photos = await takePending(item.after.key);
        if (photos) await uploadClientPhotos(item.after.orgId, data, photos);
      }
    } catch (err) {
      if (retryable(err)) left.push(item);
      else {
        logError(err, { where: 'outbox', fn: item.fn, args: item.args });
        failed.push({ ...item, error: err.message, failedAt: Date.now() });
      }
    }
  }
  // Solo se borra lo que el servidor confirmó; lo nuevo que entró durante el envío se conserva
  const seen = new Set(items.map((i) => JSON.stringify(i)));
  const added = read().filter((x) => !seen.has(JSON.stringify(x)));
  write([...left, ...added]);
  outbox.set({ syncing: false });
  if (failed.length) writeFailed([...readFailed(), ...failed]);
}

export function initOutbox() {
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && flush());
  setInterval(flush, 60 * 1000);
  let last = null;
  session.subscribe((st) => {
    const id = st.status === 'in' ? st.user?.id : null;
    if (id && id !== last) flush();
    last = id;
  });
  flush();
}
