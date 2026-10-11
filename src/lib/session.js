import { supabase } from './supabase.js';
import { rpc, logError } from './api.js';
import { createStore } from './store.js';

// Acá se maneja la sesión: inicio, cierre y estado de la suscripción
export const EMAIL_DOMAIN = 'cobros.app';
export const SYSTEM_CODE = 'sistema';

export const session = createStore({
  status: 'loading', // loading | out | in
  user: null,
  ctx: null
});

const LAST_CODE = 'ultimo-codigo-ruta';

export function lastRouteCode() {
  try {
    return localStorage.getItem(LAST_CODE) || '';
  } catch {
    return '';
  }
}

export const toEmail = (code, username) =>
  `${username.trim().toLowerCase()}@${code.trim().toLowerCase()}.${EMAIL_DOMAIN}`;

export async function login(code, username, password) {
  const { error } = await supabase.auth.signInWithPassword({ email: toEmail(code, username), password });
  if (error) {
    if (/banned/i.test(error.message)) throw new Error('Tu usuario está desactivado. Comunícate con tu administrador.');
    if (/invalid/i.test(error.message)) throw new Error('El código de ruta, el usuario o la contraseña no coinciden.');
    throw new Error('No pudimos iniciar sesión. Revisa tu conexión.');
  }
  try {
    localStorage.setItem(LAST_CODE, code.trim().toLowerCase());
  } catch {}
  await refreshContext();
}

export async function logout() {
  await supabase.auth.signOut();
  session.set({ status: 'out', user: null, ctx: null });
}

// Consulta el rol, la ruta y si la suscripción permite trabajar
export async function refreshContext() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    session.set({ status: 'out', user: null, ctx: null });
    return;
  }
  try {
    const ctx = await rpc('get_session_context');
    session.set({ status: 'in', user: data.session.user, ctx });
    cacheContext(ctx);
  } catch (err) {
    // Sin señal: se usa el último contexto guardado para seguir trabajando
    const cached = readCachedContext();
    if (cached) session.set({ status: 'in', user: data.session.user, ctx: { ...cached, offline: true } });
    else {
      logError(err, { where: 'refreshContext' });
      session.set({ status: 'out', user: null, ctx: null });
    }
  }
}

function cacheContext(ctx) {
  try {
    localStorage.setItem('ctx.v1', JSON.stringify(ctx));
  } catch {}
}

function readCachedContext() {
  try {
    return JSON.parse(localStorage.getItem('ctx.v1'));
  } catch {
    return null;
  }
}

export const canWrite = () => {
  const ctx = session.get().ctx;
  return !!ctx && (ctx.role === 'super_admin' || ctx.can_write !== false);
};

export function initSession() {
  refreshContext();
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') session.set({ status: 'out', user: null, ctx: null });
  });
  // Al volver a la app se revisa de nuevo si el usuario sigue activo y la suscripción al día
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session.get().status === 'in') refreshContext();
  });
  setInterval(() => session.get().status === 'in' && refreshContext(), 5 * 60 * 1000);
}
