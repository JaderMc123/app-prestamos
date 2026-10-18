import { supabase } from '../../lib/supabase.js';
import { q } from '../../lib/api.js';
import { addDays, fmtDate, todayISO } from '../../lib/dates.js';

// Acá se guarda el sueldo de cada cobrador (valor y cada cuánto se paga) y se calcula el periodo actual
export const SALARY_FREQ = [
  { value: 'diario', label: 'Diario' },
  { value: 'quincenal', label: 'Quincenal' },
  { value: 'mensual', label: 'Mensual' }
];

export const fetchSalaries = () =>
  q(supabase.from('fixed_costs').select('id,collector_id,amount,frequency,is_active,collector:profiles!fixed_costs_collector_id_fkey(full_name)').eq('name', 'Sueldo').eq('is_active', true));

export async function saveSalary(orgId, collectorId, amount, frequency) {
  const existing = await q(supabase.from('fixed_costs').select('id').eq('name', 'Sueldo').eq('collector_id', collectorId).maybeSingle());
  if (!amount) {
    if (existing) await q(supabase.from('fixed_costs').update({ is_active: false }).eq('id', existing.id));
    return;
  }
  if (existing) await q(supabase.from('fixed_costs').update({ amount, frequency, is_active: true }).eq('id', existing.id));
  else await q(supabase.from('fixed_costs').insert({ organization_id: orgId, collector_id: collectorId, name: 'Sueldo', amount, frequency, is_active: true }));
}

// Periodo que se está pagando hoy según la frecuencia
export function salaryPeriod(frequency, today = todayISO()) {
  const day = Number(today.slice(8, 10));
  const month = today.slice(0, 8);
  const lastDay = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  if (frequency === 'diario') return { from: today, to: today, label: 'de hoy' };
  if (frequency === 'quincenal') {
    return day <= 15
      ? { from: month + '01', to: month + '15', label: `del 1 al 15 de ${fmtDate(today, { month: 'long' })}` }
      : { from: month + '16', to: month + String(lastDay).padStart(2, '0'), label: `del 16 al ${lastDay} de ${fmtDate(today, { month: 'long' })}` };
  }
  return { from: month + '01', to: month + String(lastDay).padStart(2, '0'), label: `de ${fmtDate(today, { month: 'long' })}` };
}

// Pagos de sueldo hechos en el periodo actual de cada cobrador
export const fetchSalaryPayments = () =>
  q(supabase.from('expenses').select('id,fixed_cost_id,amount,expense_date').eq('category', 'Sueldo').gte('expense_date', addDays(todayISO(), -40)));
