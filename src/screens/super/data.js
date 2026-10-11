import { supabase } from '../../lib/supabase.js';
import { q, rpc } from '../../lib/api.js';
import { todayISO } from '../../lib/dates.js';

// Acá se cargan los datos del súper admin: rutas, pagos de suscripción y logs
export const ACCESS = {
  full: { label: 'Al día', tone: 'ok' },
  grace: { label: 'En días de gracia', tone: 'amber' },
  readonly: { label: 'Solo lectura', tone: 'coral' },
  blocked: { label: 'Suspendida', tone: 'coral' }
};

export function accessOf(r) {
  if (r.access_level === 'full' && r.days_left != null && r.days_left <= 5) return { label: r.days_left === 0 ? 'Vence hoy' : `Vence en ${r.days_left} día${r.days_left === 1 ? '' : 's'}`, tone: 'lav' };
  if (r.subscription_exempt && r.access_level === 'full') return { label: 'Acceso especial', tone: 'lime' };
  return ACCESS[r.access_level] || ACCESS.full;
}

export const fetchOverview = () => rpc('sa_overview');

export async function fetchMonthIncome() {
  const start = todayISO().slice(0, 8) + '01';
  const rows = await q(supabase.from('subscription_payments').select('amount_charged').gte('paid_at', start + 'T00:00:00-05:00'));
  return rows.reduce((s, r) => s + Number(r.amount_charged), 0);
}

export const fetchOrg = (id) => q(supabase.from('organizations').select('*').eq('id', id).single());

export const fetchOrgUsers = (id) =>
  q(supabase.from('profiles').select('id,full_name,username,role,is_active,last_seen_at').eq('organization_id', id).order('role').order('full_name'));

export const fetchOrgPayments = (id) =>
  q(supabase.from('subscription_payments').select('*').eq('organization_id', id).order('paid_at', { ascending: false }).limit(24));

export function fetchLogs({ kind, orgId, limit = 80 }) {
  const table = kind === 'errores' ? 'error_logs' : 'audit_logs';
  const cols = kind === 'errores' ? 'id,created_at,level,source,message,url,organization_id,user:profiles(full_name,username)' : 'id,created_at,action,entity,entity_id,changed_fields,organization_id,actor:profiles(full_name,username)';
  let b = supabase.from(table).select(cols).order('created_at', { ascending: false }).limit(limit);
  if (orgId === 'none') b = b.is('organization_id', null);
  else if (orgId) b = b.eq('organization_id', orgId);
  return q(b);
}
