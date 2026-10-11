import { supabase } from './supabase.js';

// Acá se traducen los códigos de error de la base de datos a mensajes claros
const MESSAGES = {
  NO_AUTORIZADO: 'No tienes permiso para hacer esto.',
  SUSCRIPCION_VENCIDA: 'La suscripción no ha sido pagada. La app está en modo solo lectura.',
  CAPITAL_INSUFICIENTE: 'No hay capital suficiente.',
  PAGO_EXCEDE_SALDO: 'El abono es mayor que lo que debe el cliente.',
  REFERENCIA_DUPLICADA: 'Ya existe un pago con ese comprobante.',
  CUENTA_INVALIDA: 'Selecciona la cuenta que recibió la transferencia.',
  TRANSFERENCIAS_PENDIENTES: 'Hay transferencias sin verificar.',
  PRESTAMO_CERRADO: 'Este préstamo ya no está activo.',
  MONTO_INVALIDO: 'Revisa el monto.',
  USUARIO_INVALIDO: 'El usuario debe tener de 3 a 30 caracteres, sin espacios.',
  CONTRASENA_INVALIDA: 'La contraseña debe tener al menos 8 caracteres.',
  CODIGO_INVALIDO: 'El código de ruta debe tener de 3 a 20 caracteres, sin espacios.',
  ERROR_CREAR_USUARIO: 'No se pudo crear el usuario.',
  ERROR_CREAR_RUTA: 'No se pudo crear la ruta.'
};

const COMBINE = new Set(['CAPITAL_INSUFICIENTE', 'PAGO_EXCEDE_SALDO']);

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const isOffline = (err) =>
  !navigator.onLine || /fetch|network|Failed to fetch|NetworkError|Load failed/i.test(String(err?.message || err));

function toApiError(err) {
  if (err instanceof ApiError) return err;
  const raw = String(err?.message || err || 'Error');
  const m = raw.match(/^([A-Z_]{4,})(?::\s*(.*))?$/);
  if (m) {
    const [, code, detail] = m;
    const nice = detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : '';
    const text = COMBINE.has(code) && nice ? `${MESSAGES[code]} ${nice}.` : nice || MESSAGES[code] || raw;
    return new ApiError(code, text);
  }
  if (isOffline(err)) return new ApiError('SIN_CONEXION', 'Sin conexión. Revisa tu señal.');
  return new ApiError('ERROR', raw);
}

// Llama una función segura de la base de datos (RPC)
export async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw toApiError(error);
  return data;
}

// Consulta de tablas con manejo de errores uniforme
export async function q(builder) {
  const { data, error, count } = await builder;
  if (error) throw toApiError(error);
  return count !== undefined && count !== null ? { data, count } : data;
}

// Acá se llama la función del servidor que crea usuarios y cambia contraseñas
export async function manageUsers(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('manage-users', { body: { action, ...payload } });
  if (error) {
    let body = null;
    try {
      body = await error.context?.json?.();
    } catch {}
    throw new ApiError(body?.error || 'ERROR', body?.message || MESSAGES[body?.error] || 'No se pudo completar la acción.');
  }
  return data;
}

// Registra errores de la app para que el súper admin los vea en los logs
export function logError(error, context = {}) {
  try {
    supabase.rpc('log_error', {
      p_message: String(error?.message || error).slice(0, 2000),
      p_context: { ...context, code: error?.code },
      p_source: 'frontend',
      p_level: 'error',
      p_url: location.pathname,
      p_user_agent: navigator.userAgent
    });
  } catch {}
}

export const message = (err) => toApiError(err).message;
