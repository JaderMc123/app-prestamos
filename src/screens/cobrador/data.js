import { supabase } from '../../lib/supabase.js';
import { q } from '../../lib/api.js';
import { todayISO } from '../../lib/dates.js';

// Acá se arma la ruta del cobrador: a quién le toca cobrar hoy, quién está atrasado y quién en mora
export const STATE = {
  mora: { label: 'En mora', tone: 'coral', order: 0 },
  atrasado: { label: 'Atrasado', tone: 'amber', order: 1 },
  hoy: { label: 'Cobrar hoy', tone: 'lime', order: 2 },
  vence: { label: 'Por vencer', tone: 'lav', order: 3 },
  pagado: { label: 'Pagó hoy', tone: 'ok', order: 4 },
  libre: { label: 'Sin cuota hoy', tone: 'muted', order: 5 }
};

export async function fetchRoute(userId) {
  const today = todayISO();
  const [loans, paidToday] = await Promise.all([
    q(
      supabase
        .from('loans')
        .select('id,status,principal,daily_payment,total_to_pay,due_date,start_date,frequency,paperwork_fee,paperwork_status,client:clients(id,full_name,address,neighborhood,phone,document_number,latitude,longitude,blocked_by_admin),loan_installments(due_date,amount_due,amount_paid)')
        .eq('collector_id', userId)
        .in('status', ['activo', 'en_mora'])
    ),
    q(
      supabase
        .from('payments')
        .select('loan_id,amount,method,verification_status,concept')
        .eq('collector_id', userId)
        .eq('is_reversed', false)
        .in('concept', ['cuota', 'papeleria'])
        .gte('paid_at', today + 'T00:00:00-05:00')
    )
  ]);

  const paidMap = new Map();
  let collectedToday = 0;
  let pendingTransfers = 0;
  for (const p of paidToday) {
    // La papelería es del cobrador: no cuenta como cobro de la ruta
    if (p.concept === 'papeleria') continue;
    paidMap.set(p.loan_id, (paidMap.get(p.loan_id) || 0) + Number(p.amount));
    collectedToday += Number(p.amount);
    if (p.verification_status === 'pendiente') pendingTransfers++;
  }

  const items = loans.map((l) => {
    let owedToDate = 0;
    let overdue = 0;
    let balance = 0;
    let dueToday = false;
    for (const i of l.loan_installments || []) {
      const left = Number(i.amount_due) - Number(i.amount_paid);
      balance += left;
      if (i.due_date <= today) owedToDate += left;
      if (i.due_date < today) overdue += left;
      if (i.due_date === today) dueToday = true;
    }
    const paid = paidMap.get(l.id) || 0;
    const daysLeft = Math.round((new Date(l.due_date) - new Date(today)) / 86400000);
    let state = 'libre';
    if (l.status === 'en_mora') state = 'mora';
    else if (overdue > 0.5) state = 'atrasado';
    else if (paid > 0 && owedToDate <= 0.5) state = 'pagado';
    else if (dueToday) state = daysLeft <= 3 ? 'vence' : 'hoy';
    return {
      id: l.id,
      client: l.client,
      daily: Number(l.daily_payment),
      frequency: l.frequency || 'diario',
      paperwork: l.paperwork_status === 'pendiente' ? Number(l.paperwork_fee) : 0,
      owedToDate,
      overdue,
      balance,
      paidToday: paid,
      dueDate: l.due_date,
      daysLeft,
      state
    };
  });

  items.sort((a, b) => STATE[a.state].order - STATE[b.state].order || b.owedToDate - a.owedToDate);

  // Meta del día: lo ya cobrado más lo que falta por cobrar hasta hoy
  const remaining = items.reduce((s, i) => s + Math.max(0, i.owedToDate), 0);
  return { items, collectedToday, remaining, goal: collectedToday + remaining, pendingTransfers, at: Date.now() };
}

export const fetchAccounts = () =>
  q(supabase.from('payment_accounts').select('id,name,type,collector_id').eq('is_active', true).order('name'));

// Orden manual de la ruta guardado por el cobrador
export const fetchRouteOrder = (userId) =>
  q(supabase.from('collector_route_orders').select('loan_ids').eq('collector_id', userId).maybeSingle()).then((r) => r?.loan_ids || []);

export const saveRouteOrder = (userId, orgId, loanIds) =>
  q(supabase.from('collector_route_orders').upsert({ collector_id: userId, organization_id: orgId, loan_ids: loanIds, updated_at: new Date().toISOString() }));
