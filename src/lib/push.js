import { rpc } from './api.js';

// Acá se activan las notificaciones en el teléfono (Web Push)
const VAPID_PUBLIC = 'BPjWJ8ULrbrbUB6oYGgNb2Ud4oGma6qMbLg9KteOXM-uoeDWIh6XJypffiLD-7EWG9Nt0Hz3uJJyD7TToKMVidU';

const toBytes = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

// Estado actual: 'unsupported' | 'needs-install' | 'denied' | 'on' | 'off'
export async function pushStatus() {
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

// Pide permiso (debe llamarse al tocar un botón) y guarda el teléfono en la base de datos
export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Bloqueaste las notificaciones. Actívalas en los ajustes del teléfono para esta app.' : 'No se dio el permiso.');
  const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.ready);
  if (!reg) throw new Error('La app todavía se está instalando. Intenta de nuevo en unos segundos.');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(VAPID_PUBLIC) });
  const json = sub.toJSON();
  await rpc('save_push_subscription', { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth, p_user_agent: navigator.userAgent });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await rpc('delete_push_subscription', { p_endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

// Al cerrar sesión el teléfono deja de recibir las alertas de ese usuario
export const forgetPush = () => disablePush().catch(() => {});

// Si ya tenía permiso, se vuelve a asociar el teléfono al usuario que inició sesión
export async function resyncPush() {
  try {
    if ((await pushStatus()) === 'on') await enablePush();
  } catch {}
}
