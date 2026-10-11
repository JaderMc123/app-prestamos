import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../../lib/store.js';
import { session, canWrite } from '../../../lib/session.js';
import { supabase } from '../../../lib/supabase.js';
import { q, rpc, message } from '../../../lib/api.js';
import { useQuery, invalidate } from '../../../lib/query.js';
import { cop, parseCop } from '../../../lib/money.js';
import { addDays, todayISO } from '../../../lib/dates.js';
import { Button, Field, Pills, Select } from '../../../components/ui.jsx';
import { SuccessBurst } from '../../../components/SuccessBurst.jsx';
import { toast } from '../../../components/Toast.jsx';
import { countCollectionDays, fetchSchedule } from './data.js';
import { RiskAlerts } from './RiskAlerts.jsx';

// Acá se crea el préstamo: monto, interés, papelería diaria y fecha límite, con la cuota calculada al instante
export function LoanForm({ clientId, clientName, info, onDone }) {
  const ctx = useStore(session, (s) => s.ctx);
  const userId = useStore(session, (s) => s.user?.id);
  const isAdmin = ctx.role === 'admin';
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('20');
  const [fee, setFee] = useState('');
  const [due, setDue] = useState(addDays(todayISO(), 30));
  const [method, setMethod] = useState('efectivo');
  const [account, setAccount] = useState('');
  const [collector, setCollector] = useState(isAdmin ? '' : userId);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5, 6]);

  const collectors = useQuery(isAdmin ? 'loan:collectors' : null, () => q(supabase.from('profiles').select('id,full_name').eq('role', 'cobrador').eq('is_active', true).order('full_name')));
  const accounts = useQuery('accounts', () => q(supabase.from('payment_accounts').select('id,name,collector_id').eq('is_active', true).order('name')), { persist: true });

  useEffect(() => {
    if (collector) fetchSchedule(collector).then(setWeekdays).catch(() => {});
  }, [collector]);

  const principal = parseCop(amount);
  const paperwork = parseCop(fee);
  const interest = Math.round((principal * (Number(String(rate).replace(',', '.')) || 0)) / 100);
  const days = due ? countCollectionDays(todayISO(), due, weekdays) : 0;
  const daily = days ? Math.floor((principal + interest) / days / 100) * 100 + paperwork : 0;
  const total = principal + interest + paperwork * days;
  const needsAck = info?.risky || info?.client?.blocked_by_admin || info?.client?.blocked_by_me;

  const submit = async (e) => {
    e.preventDefault();
    if (!canWrite()) return toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
    if (!navigator.onLine) return toast('Necesitas señal para crear el préstamo (se revisa el capital disponible).', 'error');
    if (principal <= 0) return toast('Escribe el monto del préstamo.', 'error');
    if (fee === '') return toast('Escribe el valor diario de la papelería (puede ser 0).', 'error');
    if (!days) return toast('La fecha límite no deja días de cobro.', 'error');
    if (isAdmin && !collector) return toast('Elige el cobrador del préstamo.', 'error');
    if (method === 'transferencia' && !account) return toast('Elige la cuenta del desembolso.', 'error');
    if (needsAck && !ack) return toast('Confirma que entiendes la alerta de este cliente.', 'error');
    setBusy(true);
    try {
      await rpc('create_loan', {
        p_client_id: clientId,
        p_principal: principal,
        p_interest_rate: Number(String(rate).replace(',', '.')) || 0,
        p_due_date: due,
        p_collector_id: isAdmin ? collector : null,
        p_paperwork_fee: paperwork,
        p_disbursement_method: method,
        p_disbursement_account_id: method === 'transferencia' ? account : null
      });
      invalidate('route:');
      invalidate('summary:');
      invalidate('clients:');
      invalidate('admin:');
      setDone(principal);
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (done) return <SuccessBurst amount={done} title="Préstamo creado" detail={`${clientName}, cuota de ${cop(daily)}`} onDone={onDone} />;

  return (
    <form class="form" onSubmit={submit}>
      <RiskAlerts info={info} />
      {needsAck && (
        <label class="check-row" data-enter>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.currentTarget.checked)} />
          <span>Entiendo la alerta y quiero prestarle de todas formas.</span>
        </label>
      )}
      <div class="amount-input" data-enter>
        <span class="amount-currency">$</span>
        <input class="amount-field num" size={Math.max(2, principal.toLocaleString('es-CO').length)} inputMode="numeric" aria-label="Monto a prestar" value={principal ? principal.toLocaleString('es-CO') : ''} onInput={(e) => setAmount(e.currentTarget.value)} placeholder="0" />
      </div>
      <div class="form-row" data-enter>
        <Field label="Interés" inputMode="decimal" value={rate} onInput={(e) => setRate(e.currentTarget.value)} suffix={<span class="field-affix">%</span>} />
        <Field label="Papelería diaria" inputMode="numeric" prefix="$" value={fee === '' ? '' : paperwork.toLocaleString('es-CO')} onInput={(e) => setFee(e.currentTarget.value === '' ? '' : e.currentTarget.value)} />
      </div>
      <div class="form-row" data-enter>
        <Field label="Fecha límite" type="date" value={due} min={addDays(todayISO(), 1)} onInput={(e) => setDue(e.currentTarget.value)} />
        {isAdmin && (
          <Select label="Cobrador" value={collector} onChange={(e) => setCollector(e.currentTarget.value)}>
            <option value="">Elige un cobrador</option>
            {(collectors.data || []).map((c) => <option value={c.id}>{c.full_name}</option>)}
          </Select>
        )}
      </div>
      <div data-enter>
        <Pills label="Desembolso" value={method} onChange={setMethod} options={[{ value: 'efectivo', label: 'Entrega en efectivo' }, { value: 'transferencia', label: 'Por transferencia' }]} />
      </div>
      {method === 'transferencia' && (
        <Select label="Cuenta desde la que se transfiere" value={account} onChange={(e) => setAccount(e.currentTarget.value)}>
          <option value="">Elige una cuenta</option>
          {(accounts.data || []).map((a) => <option value={a.id}>{a.name}</option>)}
        </Select>
      )}
      <div class="loan-summary" data-enter>
        <div><span>Cuotas</span><b class="num">{days}</b></div>
        <div><span>Cuota diaria</span><b class="num">{cop(daily)}</b></div>
        <div><span>Total a pagar</span><b class="num">{cop(total)}</b></div>
      </div>
      <Button type="submit" size="lg" class="btn-block" loading={busy} icon="check">Prestar {principal ? cop(principal) : ''}</Button>
    </form>
  );
}
