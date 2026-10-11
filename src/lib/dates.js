// Acá están las utilidades de fechas en hora de Colombia
const TZ = 'America/Bogota';

export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function fmtDate(iso, opts = { day: 'numeric', month: 'short' }) {
  if (!iso) return '—';
  const d = typeof iso === 'string' && iso.length === 10 ? new Date(iso + 'T12:00:00') : new Date(iso);
  return new Intl.DateTimeFormat('es-CO', { timeZone: TZ, ...opts }).format(d).replace('.', '');
}

export function fmtTime(iso) {
  return new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function timeAgo(iso) {
  if (!iso) return 'Nunca';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'Hace un momento';
  if (s < 3600) return `Hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `Hace ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'Ayer' : `Hace ${d} días`;
}

export function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()));
  if (h < 12) return 'Buenos días';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

export const WEEKDAYS = [
  { n: 1, short: 'L', name: 'Lunes' },
  { n: 2, short: 'M', name: 'Martes' },
  { n: 3, short: 'X', name: 'Miércoles' },
  { n: 4, short: 'J', name: 'Jueves' },
  { n: 5, short: 'V', name: 'Viernes' },
  { n: 6, short: 'S', name: 'Sábado' },
  { n: 7, short: 'D', name: 'Domingo' }
];
