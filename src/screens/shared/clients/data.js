import { supabase } from '../../../lib/supabase.js';
import { q, rpc } from '../../../lib/api.js';
import { todayISO } from '../../../lib/dates.js';

// Acá se cargan los clientes y se calcula su estado (al día, atrasado, en mora, sin préstamo)
export const CLIENT_STATE = {
  mora: { label: 'En mora', tone: 'coral', order: 0 },
  atrasado: { label: 'Atrasado', tone: 'amber', order: 1 },
  aldia: { label: 'Al día', tone: 'lime', order: 2 },
  libre: { label: 'Sin préstamo activo', tone: 'muted', order: 3 }
};

export async function fetchClients() {
  const today = todayISO();
  const rows = await q(
    supabase
      .from('clients')
      .select('id,document_number,full_name,phone,phone2,neighborhood,address,latitude,longitude,occupation,reference_name,reference_phone,notes,data_consent_accepted,blocked_by_admin,blocked_reason,id_front_path,id_back_path,photo_path,created_at,loans(id,status,collector_id,principal,due_date,daily_payment,frequency,paperwork_fee,paperwork_status,loan_installments(due_date,amount_due,amount_paid))')
      .order('full_name')
  );
  return rows.map((c) => {
    let state = 'libre';
    let balance = 0;
    const active = (c.loans || []).filter((l) => l.status === 'activo' || l.status === 'en_mora');
    for (const l of active) {
      let overdue = 0;
      for (const i of l.loan_installments || []) {
        const left = Number(i.amount_due) - Number(i.amount_paid);
        balance += left;
        if (i.due_date < today) overdue += left;
      }
      const s = l.status === 'en_mora' ? 'mora' : overdue > 0.5 ? 'atrasado' : 'aldia';
      if (CLIENT_STATE[s].order < CLIENT_STATE[state].order) state = s;
    }
    return { ...c, state, balance, activeLoans: active };
  });
}

export const findByDocument = (doc) => rpc('find_client_by_document', { p_document: doc });

export const fetchMyBlocks = (userId) => q(supabase.from('client_blocks').select('client_id,reason').eq('collector_id', userId));

export const fetchSchedule = (collectorId) =>
  q(supabase.from('collection_schedules').select('weekdays').eq('collector_id', collectorId).maybeSingle()).then((r) => r?.weekdays || [1, 2, 3, 4, 5, 6]);

// Acá se calculan las fechas de cobro igual que la base de datos (diario, quincenal 15 y 30, mensual)
export const FREQUENCIES = {
  diario: { label: 'Diario', cuota: 'Cuota diaria', unit: ['día', 'días'] },
  quincenal: { label: 'Quincenal', cuota: 'Cuota quincenal', unit: ['quincena', 'quincenas'] },
  mensual: { label: 'Mensual', cuota: 'Cuota mensual', unit: ['mes', 'meses'] }
};

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const at = (s) => new Date(s + 'T12:00:00');
const lastDay = (y, m) => new Date(y, m + 1, 0, 12).getDate();

export function loanDates({ frequency = 'diario', start, due, count, weekdays = [1, 2, 3, 4, 5, 6] }) {
  const out = [];
  if (!start || (!due && !count)) return out;
  const begin = at(start);
  const limit = due ? at(due) : null;
  const enough = () => count && out.length >= count;
  if (frequency === 'diario') {
    const d = new Date(begin);
    for (let i = 0; i < 3000 && !enough(); i++) {
      d.setDate(d.getDate() + 1);
      if (!count && d > limit) break;
      if (weekdays.includes(d.getDay() === 0 ? 7 : d.getDay())) out.push(iso(d));
    }
  } else if (frequency === 'quincenal') {
    let y = begin.getFullYear();
    let m = begin.getMonth();
    for (let i = 0; i < 400 && !enough(); i++) {
      for (const day of [15, Math.min(30, lastDay(y, m))]) {
        const d = new Date(y, m, day, 12);
        if (d > begin && (count || d <= limit) && !enough()) out.push(iso(d));
      }
      if (!count && new Date(y, m, 1, 12) > limit) break;
      m++;
      if (m > 11) { m = 0; y++; }
    }
  } else {
    for (let k = 1; k <= 400; k++) {
      if (count && k > count) break;
      const y = begin.getFullYear() + Math.floor((begin.getMonth() + k) / 12);
      const m = (begin.getMonth() + k) % 12;
      const d = new Date(y, m, Math.min(begin.getDate(), lastDay(y, m)), 12);
      if (!count && d > limit) break;
      out.push(iso(d));
    }
  }
  return out;
}

// Cuota igual que en la base de datos: redondeada hacia abajo y la última absorbe la diferencia
export function installmentPlan(total, n, rounding = 100) {
  if (!n || total <= 0) return { per: 0, last: 0 };
  let per = rounding > 0 ? Math.floor(total / n / rounding) * rounding : 0;
  if (per <= 0) per = Math.floor((total / n) * 100) / 100;
  return { per, last: Math.round((total - per * (n - 1)) * 100) / 100 };
}
