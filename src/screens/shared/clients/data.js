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
      .select('id,document_number,full_name,phone,phone2,neighborhood,address,latitude,longitude,occupation,reference_name,reference_phone,notes,data_consent_accepted,blocked_by_admin,blocked_reason,id_front_path,id_back_path,photo_path,created_at,loans(id,status,collector_id,principal,due_date,daily_payment,loan_installments(due_date,amount_due,amount_paid))')
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

// Cuenta los días de cobro entre mañana y la fecha límite (igual que lo hace la base de datos)
export function countCollectionDays(start, end, weekdays) {
  let n = 0;
  const d = new Date(start + 'T12:00:00');
  const last = new Date(end + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  while (d <= last) {
    const iso = d.getDay() === 0 ? 7 : d.getDay();
    if (weekdays.includes(iso)) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}
