import { supabase } from '../../../lib/supabase.js';
import { q } from '../../../lib/api.js';
import { todayISO } from '../../../lib/dates.js';

// Acá se calcula qué tan buen cliente es cada uno: puntualidad, mora, ganancia que deja y si conviene ofrecerle
export const LEVELS = {
  excelente: { label: 'Excelente', tone: 'lime', advice: 'Ofrécele un nuevo préstamo', icon: 'check', order: 0 },
  bueno: { label: 'Bueno', tone: 'ok', advice: 'Puedes ofrecerle', icon: 'check', order: 1 },
  nuevo: { label: 'Nuevo', tone: 'lav', advice: 'Aún sin historial suficiente', icon: 'user', order: 2 },
  regular: { label: 'Con cuidado', tone: 'amber', advice: 'Préstale poco y vigílalo', icon: 'alert', order: 3 },
  malo: { label: 'Riesgoso', tone: 'coral', advice: 'No le prestes más', icon: 'lock', order: 4 }
};

export const CONCEPT = { cuota: 'Cuota', papeleria: 'Papelería', saldo_anterior: 'Saldo anterior', renovacion: 'Renovación' };

const day = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(ts));
const diffDays = (a, b) => Math.round((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);

// Se piden por separado (préstamos con cuotas y pagos con su reparto) y se unen en el celular: más rápido y sin ambigüedades
const withTimeout = (p, ms = 20000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('El servidor se demoró demasiado. Intenta de nuevo.')), ms))]);

export async function fetchInsightsData() {
  const [loans, payments] = await withTimeout(
    Promise.all([
      q(
        supabase
          .from('loans')
          .select('id,client_id,status,principal,interest_amount,total_to_pay,start_date,due_date,was_overdue,paperwork_fee,paperwork_status,frequency,imported,collector_id,loan_installments(id,due_date,amount_due,amount_paid,kind)')
          .order('start_date', { ascending: false })
          .limit(2000)
      ),
      q(
        supabase
          .from('payments')
          .select('id,loan_id,amount,paid_at,method,concept,verification_status,is_reversed,notes,payment_allocations(installment_id,interest_part,paperwork_part,late_fee_part)')
          .order('paid_at', { ascending: false })
          .limit(10000)
      )
    ])
  );
  const byLoan = new Map();
  for (const p of payments || []) {
    if (!byLoan.has(p.loan_id)) byLoan.set(p.loan_id, []);
    byLoan.get(p.loan_id).push(p);
  }
  return (loans || []).map((l) => ({ ...l, payments: byLoan.get(l.id) || [] }));
}

// Historial de un solo cliente (para su ficha): liviano y no depende de cargar toda la ruta
export async function fetchClientHistory(clientId) {
  const loans = await withTimeout(
    q(
      supabase
        .from('loans')
        .select('id,client_id,status,principal,interest_amount,total_to_pay,start_date,due_date,was_overdue,paperwork_fee,paperwork_status,frequency,imported,collector_id,loan_installments(id,due_date,amount_due,amount_paid,kind)')
        .eq('client_id', clientId)
    ),
    15000
  );
  if (!loans?.length) return [];
  const payments = await withTimeout(
    q(
      supabase
        .from('payments')
        .select('id,loan_id,amount,paid_at,method,concept,verification_status,is_reversed,notes,payment_allocations(installment_id,interest_part,paperwork_part,late_fee_part)')
        .in('loan_id', loans.map((l) => l.id))
        .order('paid_at', { ascending: false })
    ),
    15000
  );
  return loans.map((l) => ({ ...l, payments: (payments || []).filter((p) => p.loan_id === l.id) }));
}

// Resumen de un cliente a partir de todos sus préstamos y pagos
export function scoreClient(loans = [], blocked = false) {
  const today = todayISO();
  let onTime = 0;
  let counted = 0;
  let lateDays = 0;
  let lateCount = 0;
  let profit = 0;
  let paidTotal = 0;
  let lastPayment = null;
  let moraLoans = 0;
  let inMora = false;
  let finished = 0;
  let activeProgress = null;
  const payments = [];

  for (const l of loans) {
    if (l.was_overdue || l.status === 'en_mora') moraLoans++;
    if (l.status === 'en_mora') inMora = true;
    if (l.status === 'pagado' || l.status === 'renovado') finished++;

    // Fecha en que quedó pagada cada cuota (por el último abono que la cubrió)
    const paidOn = new Map();
    const onlyOld = new Map();
    for (const p of l.payments || []) {
      payments.push({ ...p, loan_id: l.id, loan_principal: l.principal });
      if (p.is_reversed || p.verification_status === 'rechazado') continue;
      if (p.concept !== 'renovacion' && p.concept !== 'papeleria') paidTotal += Number(p.amount);
      if (p.concept !== 'saldo_anterior' && p.concept !== 'renovacion' && (!lastPayment || p.paid_at > lastPayment)) lastPayment = p.paid_at;
      const d = day(p.paid_at);
      for (const a of p.payment_allocations || []) {
        if (p.concept !== 'saldo_anterior') profit += Number(a.interest_part) + Number(a.paperwork_part) + Number(a.late_fee_part);
        const prev = paidOn.get(a.installment_id);
        if (!prev || d > prev) paidOn.set(a.installment_id, d);
        onlyOld.set(a.installment_id, (onlyOld.get(a.installment_id) ?? true) && p.concept === 'saldo_anterior');
      }
    }

    let due = 0;
    let paid = 0;
    for (const i of l.loan_installments || []) {
      due += Number(i.amount_due);
      paid += Number(i.amount_paid);
      if (i.kind !== 'regular' || i.due_date >= today) continue;
      if (onlyOld.get(i.id)) continue; // pagada antes de usar la app: no se sabe si fue a tiempo
      counted++;
      const complete = Number(i.amount_paid) >= Number(i.amount_due) - 0.5;
      const when = paidOn.get(i.id);
      if (complete && when && when <= i.due_date) onTime++;
      else {
        lateCount++;
        lateDays += Math.max(1, diffDays(complete && when ? when : today, i.due_date));
      }
    }
    if ((l.status === 'activo' || l.status === 'en_mora') && due > 0) activeProgress = Math.max(activeProgress ?? 0, paid / due);
  }

  const punctuality = counted ? onTime / counted : null;
  let score = punctuality == null ? 70 : Math.round(punctuality * 100);
  score -= Math.min(45, moraLoans * 15);
  if (inMora) score -= 10;
  score += Math.min(15, finished * 5);
  if (blocked) score = Math.min(score, 30);
  score = Math.max(0, Math.min(100, score));

  let level = score >= 85 ? 'excelente' : score >= 65 ? 'bueno' : score >= 45 ? 'regular' : 'malo';
  if (inMora && level !== 'malo') level = 'regular';
  if (blocked) level = 'malo';
  if (counted < 3 && !moraLoans && !blocked && !inMora) level = 'nuevo';

  // Conviene ofrecerle si paga bien y no tiene un préstamo a medias
  const offer = (level === 'excelente' || level === 'bueno') && !inMora && (activeProgress == null || activeProgress >= 0.7);

  payments.sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at));
  return {
    score,
    level,
    offer,
    good: (level === 'excelente' || level === 'bueno') && !inMora,
    progress: activeProgress,
    punctuality,
    avgLate: lateCount ? Math.round(lateDays / lateCount) : 0,
    lateCount,
    counted,
    moraLoans,
    inMora,
    finished,
    loans: loans.length,
    profit: Math.round(profit),
    paidTotal: Math.round(paidTotal),
    lastPayment,
    payments
  };
}

// Agrupa los préstamos por cliente y calcula el resumen de todos
export function buildInsights(loanRows = [], clients = []) {
  const byClient = new Map();
  for (const l of loanRows) {
    if (!byClient.has(l.client_id)) byClient.set(l.client_id, []);
    byClient.get(l.client_id).push(l);
  }
  const out = new Map();
  for (const c of clients) out.set(c.id, scoreClient(byClient.get(c.id) || [], c.blocked_by_admin || c.blocked_by_me));
  return out;
}
