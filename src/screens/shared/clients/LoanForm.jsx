import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../../lib/store.js';
import { session, canWrite } from '../../../lib/session.js';
import { supabase } from '../../../lib/supabase.js';
import { q, rpc, message } from '../../../lib/api.js';
import { useQuery, invalidate } from '../../../lib/query.js';
import { cop, parseCop } from '../../../lib/money.js';
import { addDays, fmtDate, todayISO } from '../../../lib/dates.js';
import { Button, Field, Pills, Select, Switch } from '../../../components/ui.jsx';
import { SuccessBurst } from '../../../components/SuccessBurst.jsx';
import { toast } from '../../../components/Toast.jsx';
import { FREQUENCIES, fetchSchedule, installmentPlan, loanDates } from './data.js';
import { RiskAlerts } from './RiskAlerts.jsx';

// Acá se crea el préstamo: monto, frecuencia, plazo (cuotas o fecha) y papelería opcional, con la cuota calculada al instante
const DEFAULT_COUNT = { diario: '30', quincenal: '4', mensual: '2' };

export const fetchLoanSettings = (orgId) =>
  q(supabase.from('settings').select('default_interest_rate,frequencies,installment_rounding').eq('organization_id', orgId).maybeSingle());

export function LoanForm({ clientId, clientName, info, onDone }) {
  const ctx = useStore(session, (s) => s.ctx);
  const userId = useStore(session, (s) => s.user?.id);
  const isAdmin = ctx.role === 'admin';
  const settings = useQuery(`settings:loan:${ctx.organization.id}`, () => fetchLoanSettings(ctx.organization.id), { persist: true });
  const cfg = settings.data || { default_interest_rate: 20, frequencies: ['diario'], installment_rounding: 100 };
  const allowed = isAdmin ? Object.keys(FREQUENCIES) : (cfg.frequencies?.length ? cfg.frequencies : ['diario']);

  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [frequency, setFrequency] = useState('diario');
  const [term, setTerm] = useState('cuotas');
  const [count, setCount] = useState(DEFAULT_COUNT.diario);
  const [due, setDue] = useState(addDays(todayISO(), 30));
  const [withFee, setWithFee] = useState(false);
  const [fee, setFee] = useState('');
  const [deduct, setDeduct] = useState(false);
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

  useEffect(() => {
    if (isAdmin && settings.data && rate === '') setRate(String(Number(settings.data.default_interest_rate ?? 20)));
  }, [settings.data]);

  // Si el admin cambia la configuración, se toma la frecuencia permitida
  useEffect(() => {
    if (!allowed.includes(frequency)) changeFrequency(allowed[0]);
  }, [allowed.join()]);

  const changeFrequency = (f) => {
    setFrequency(f);
    setCount(DEFAULT_COUNT[f]);
    setDue(addDays(todayISO(), f === 'diario' ? 30 : 60));
  };

  const principal = parseCop(amount);
  const paperwork = withFee ? parseCop(fee) : 0;
  const pct = isAdmin && rate !== '' ? Number(String(rate).replace(',', '.')) || 0 : Number(cfg.default_interest_rate) || 0;
  const interest = Math.round((principal * pct) / 100);
  const nCount = Math.max(0, Math.min(400, parseInt(count, 10) || 0));
  const dates = loanDates({ frequency, start: todayISO(), due: term === 'fecha' ? due : null, count: term === 'cuotas' ? nCount : null, weekdays });
  const n = dates.length;
  const { per, last } = installmentPlan(principal + interest, n, Number(cfg.installment_rounding ?? 100));
  const total = principal + interest;
  const handed = principal - (paperwork && deduct ? paperwork : 0);
  const unit = FREQUENCIES[frequency].unit;
  const needsAck = info?.risky || info?.client?.blocked_by_admin || info?.client?.blocked_by_me;

  const submit = async (e) => {
    e.preventDefault();
    if (!canWrite()) return toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
    if (!navigator.onLine) return toast('Necesitas señal para crear el préstamo (se revisa el capital disponible).', 'error');
    if (principal <= 0) return toast('Escribe el monto del préstamo.', 'error');
    if (withFee && paperwork <= 0) return toast('Escribe el valor de la papelería o desactívala.', 'error');
    if (paperwork && deduct && paperwork >= principal) return toast('La papelería no puede ser mayor que el préstamo.', 'error');
    if (!n) return toast(term === 'cuotas' ? 'Escribe cuántas cuotas.' : 'La fecha límite no deja fechas de cobro.', 'error');
    if (isAdmin && !collector) return toast('Elige el cobrador del préstamo.', 'error');
    if (method === 'transferencia' && !account) return toast('Elige la cuenta del desembolso.', 'error');
    if (needsAck && !ack) return toast('Confirma que entiendes la alerta de este cliente.', 'error');
    setBusy(true);
    try {
      await rpc('create_loan', {
        p_client_id: clientId,
        p_principal: principal,
        p_interest_rate: isAdmin ? pct : null,
        p_due_date: term === 'fecha' ? due : null,
        p_installments: term === 'cuotas' ? nCount : null,
        p_frequency: frequency,
        p_collector_id: isAdmin ? collector : null,
        p_paperwork_fee: paperwork,
        p_paperwork_deduct: !!paperwork && deduct,
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

  if (done)
    return (
      <SuccessBurst
        amount={done}
        title="Préstamo creado"
        detail={`${clientName}, ${n} ${unit[n === 1 ? 0 : 1]} de ${cop(per)}${paperwork && !deduct ? `. Papelería de ${cop(paperwork)} por cobrar` : ''}`}
        onDone={onDone}
      />
    );

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

      {allowed.length > 1 && (
        <div data-enter>
          <span class="field-label">Frecuencia de cobro</span>
          <Pills label="Frecuencia de cobro" value={frequency} onChange={changeFrequency} options={allowed.map((f) => ({ value: f, label: FREQUENCIES[f].label }))} />
          {frequency === 'quincenal' && <p class="field-hint">Se cobra los días 15 y 30 de cada mes.</p>}
        </div>
      )}

      <div data-enter>
        <span class="field-label">Plazo</span>
        <Pills label="Plazo" value={term} onChange={setTerm} options={[{ value: 'cuotas', label: `Por número de ${unit[1]}` }, { value: 'fecha', label: 'Por fecha final' }]} />
      </div>
      <div class="form-row" data-enter>
        {term === 'cuotas' ? (
          <Field label={`Número de ${unit[1]}`} type="number" min="1" max="400" inputMode="numeric" value={count} onInput={(e) => setCount(e.currentTarget.value)} hint={n ? `Última cuota: ${fmtDate(dates[n - 1], { day: 'numeric', month: 'short', year: 'numeric' })}` : null} />
        ) : (
          <Field label="Fecha límite" type="date" value={due} min={addDays(todayISO(), 1)} onInput={(e) => setDue(e.currentTarget.value)} hint={n ? `${n} ${unit[n === 1 ? 0 : 1]} de cobro` : null} />
        )}
        {isAdmin ? (
          <Field label="Interés" inputMode="decimal" value={rate} onInput={(e) => setRate(e.currentTarget.value)} suffix={<span class="field-affix">%</span>} />
        ) : (
          <Field label="Interés" value={`${Number(cfg.default_interest_rate ?? 20)}`} disabled suffix={<span class="field-affix">%</span>} hint="Lo configura el administrador" />
        )}
      </div>

      {isAdmin && (
        <div data-enter>
          <Select label="Cobrador" value={collector} onChange={(e) => setCollector(e.currentTarget.value)}>
            <option value="">Elige un cobrador</option>
            {(collectors.data || []).map((c) => <option value={c.id}>{c.full_name}</option>)}
          </Select>
        </div>
      )}

      <section class="form-section" data-enter>
        <Switch label="Cobrar papelería" hint="Es un cobro único, aparte de las cuotas." checked={withFee} onChange={setWithFee} />
        {withFee && (
          <>
            <Field label="Valor de la papelería" inputMode="numeric" prefix="$" value={paperwork ? paperwork.toLocaleString('es-CO') : ''} onInput={(e) => setFee(e.currentTarget.value)} />
            <Switch
              label="Descontarla de lo que se entrega"
              hint={deduct ? `Se entregan ${cop(Math.max(0, handed))} al cliente y la papelería (${cop(paperwork)}) te queda a ti.` : 'La cobras cuando quieras desde el panel de cobro. La papelería es del cobrador.'}
              checked={deduct}
              onChange={setDeduct}
            />
          </>
        )}
      </section>

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
        <div><span>Cuotas</span><b class="num">{n}</b></div>
        <div><span>{FREQUENCIES[frequency].cuota}</span><b class="num">{cop(per)}</b></div>
        <div><span>Total a pagar</span><b class="num">{cop(total)}</b></div>
      </div>
      {n > 1 && Math.abs(last - per) >= 1 && <p class="field-hint" data-enter>La última cuota es de {cop(last)} para completar el total.</p>}
      <Button type="submit" size="lg" class="btn-block" loading={busy} icon="check">Prestar {principal ? cop(principal) : ''}</Button>
    </form>
  );
}
