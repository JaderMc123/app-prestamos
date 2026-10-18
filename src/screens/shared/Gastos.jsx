import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session } from '../../lib/session.js';
import { supabase } from '../../lib/supabase.js';
import { q } from '../../lib/api.js';
import { useQuery } from '../../lib/query.js';
import { signedUrl } from '../../lib/images.js';
import { cop } from '../../lib/money.js';
import { addDays, fmtDate, fmtTime, todayISO } from '../../lib/dates.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Sheet } from '../../components/Sheet.jsx';
import { Button, Empty, ErrorState, Pills, Select, Skeleton } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { categoryOf, GastoSheet } from './GastoSheet.jsx';
import { SALARY_FREQ, fetchSalaries, fetchSalaryPayments, salaryPeriod } from './sueldos.js';
import { send, uuid } from '../../lib/outbox.js';
import { canWrite } from '../../lib/session.js';
import { message } from '../../lib/api.js';
import { invalidate } from '../../lib/query.js';
import { parseCop } from '../../lib/money.js';
import { Field } from '../../components/ui.jsx';
import { toast } from '../../components/Toast.jsx';
import { Link } from '../../lib/router.jsx';

// Acá se ven los gastos operativos: cuánto se fue en gasolina, mecánico, imprevistos... por periodo y por cobrador
const PERIODS = [
  { value: 'mes', label: 'Este mes' },
  { value: 'pasado', label: 'Mes pasado' },
  { value: '7', label: '7 días' },
  { value: '90', label: '3 meses' }
];

function range(p) {
  const t = todayISO();
  const first = t.slice(0, 8) + '01';
  if (p === 'mes') return [first, t];
  if (p === 'pasado') {
    const d = new Date(first + 'T12:00:00');
    d.setMonth(d.getMonth() - 1);
    const start = d.toISOString().slice(0, 10).slice(0, 8) + '01';
    return [start, addDays(first, -1)];
  }
  return [addDays(t, -Number(p)), t];
}

const fetchExpenses = ([from, to], collector) => {
  let b = supabase
    .from('expenses')
    .select('id,kind,category,description,amount,expense_date,receipt_path,created_at,collector_id,collector:profiles!expenses_collector_id_fkey(full_name)')
    .gte('expense_date', from)
    .lte('expense_date', to)
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500);
  if (collector === 'ruta') b = b.is('collector_id', null);
  else if (collector) b = b.eq('collector_id', collector);
  return q(b);
};

function ReceiptPhoto({ path }) {
  const url = useQuery(path ? `receipt:${path}` : null, () => signedUrl(path, 'receipts'));
  if (!path) return null;
  if (!url.data) return <Skeleton h={180} r={18} />;
  return (
    <a href={url.data} target="_blank" rel="noopener" class="receipt-photo">
      <img src={url.data} alt="Recibo del gasto" />
    </a>
  );
}

// Sueldos de los cobradores: cuánto toca pagar en el periodo y botón para pagarlo
function PaySalarySheet({ item, onClose }) {
  const ctx = useStore(session, (s) => s.ctx);
  const me = useStore(session, (s) => s.user?.id);
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('admin');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAmount('');
    setFrom('admin');
  }, [item?.id]);
  if (!item) return null;
  const value = amount === '' ? item.pending : parseCop(amount);
  const pay = async () => {
    if (!canWrite()) return toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
    if (value <= 0) return toast('Escribe el valor a pagar.', 'error');
    setBusy(true);
    try {
      await send('insert_expense', {
        organization_id: ctx.organization.id,
        collector_id: item.collector_id,
        created_by: me,
        fixed_cost_id: item.id,
        kind: from === 'cobrador' ? 'eventual_cobrador' : 'fijo_admin',
        category: 'Sueldo',
        description: `Sueldo ${item.period.label} de ${item.collector?.full_name || 'cobrador'}`,
        amount: value,
        expense_date: todayISO(),
        client_uuid: uuid()
      });
      toast(`Sueldo pagado: ${cop(value)}`);
      invalidate('expenses:');
      invalidate('admin:');
      onClose();
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={!!item} onClose={onClose} title={`Pagar sueldo a ${item.collector?.full_name || 'cobrador'}`} subtitle={`Periodo ${item.period.label}`}>
      <div class="form">
        <div data-enter>
          <Field label="Valor a pagar" inputMode="numeric" prefix="$" value={value ? value.toLocaleString('es-CO') : ''} onInput={(e) => setAmount(e.currentTarget.value)} hint={item.paid > 0 ? `Ya le pagaste ${cop(item.paid)} de ${cop(item.amount)} en este periodo.` : `Su sueldo es ${cop(item.amount)} ${SALARY_FREQ.find((f) => f.value === item.frequency)?.label.toLowerCase()}.`} />
        </div>
        <div data-enter>
          <span class="field-label">¿De dónde sale la plata?</span>
          <Pills label="De dónde sale" value={from} onChange={setFrom} options={[{ value: 'admin', label: 'De mi caja' }, { value: 'cobrador', label: 'Lo toma de lo que cobró' }]} />
          <p class="field-hint">{from === 'cobrador' ? 'Se descuenta de la caja del cobrador: en el cuadre te entrega menos.' : 'Se descuenta de tu caja.'}</p>
        </div>
        <Button size="lg" class="btn-block" icon="check" loading={busy} onClick={pay}>Pagar {cop(value)}</Button>
      </div>
    </Sheet>
  );
}

function SueldosCard() {
  const salaries = useQuery('admin:salaries', fetchSalaries);
  const payments = useQuery('expenses:salary-payments', fetchSalaryPayments);
  const [paying, setPaying] = useState(null);
  const rows = (salaries.data || []).map((x) => {
    const period = salaryPeriod(x.frequency);
    const paid = (payments.data || []).filter((p) => p.fixed_cost_id === x.id && p.expense_date >= period.from && p.expense_date <= period.to).reduce((s, p) => s + Number(p.amount), 0);
    return { ...x, period, paid, pending: Math.max(0, Number(x.amount) - paid) };
  });
  const pendingTotal = rows.reduce((s, r) => s + r.pending, 0);
  return (
    <section class="expense-summary" data-enter>
      <div class="salary-head">
        <div>
          <span class="muted">Sueldos de cobradores</span>
          <b class="num">{pendingTotal > 0 ? `${cop(pendingTotal)} por pagar` : rows.length ? 'Al día' : 'Sin sueldos'}</b>
        </div>
        <Link href="/cobradores" class="link-btn">Configurar</Link>
      </div>
      {salaries.loading && !salaries.data ? (
        <Skeleton h={48} r={14} />
      ) : !rows.length ? (
        <p class="muted">Pon el sueldo de cada cobrador en Cobradores → su nombre → Configuración.</p>
      ) : (
        <div class="list-card list-flat">
          {rows.map((r) => (
            <div class="row">
              <span class={`row-icon ${r.pending > 0 ? 'tone-bg-amber' : 'tone-bg-lime'}`}><Icon name={r.pending > 0 ? 'calendar' : 'check'} size={17} /></span>
              <div class="row-main">
                <span class="row-title">{r.collector?.full_name || 'Cobrador'}</span>
                <span class="row-sub">{cop(r.amount)} {SALARY_FREQ.find((f) => f.value === r.frequency)?.label.toLowerCase()} · {r.pending > 0 ? `falta ${cop(r.pending)} ${r.period.label}` : `pagado ${r.period.label}`}</span>
              </div>
              {r.pending > 0 ? <Button size="sm" onClick={() => setPaying(r)}>Pagar</Button> : <span class="tag tag-lime">Pagado</span>}
            </div>
          ))}
        </div>
      )}
      <PaySalarySheet item={paying} onClose={() => setPaying(null)} />
    </section>
  );
}

export function Gastos() {
  const ctx = useStore(session, (s) => s.ctx);
  const me = useStore(session, (s) => s.user?.id);
  const isAdmin = ctx.role === 'admin';
  const [period, setPeriod] = useState('mes');
  const [who, setWho] = useState('');
  const [cat, setCat] = useState('');
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const r = range(period);

  const people = useQuery(isAdmin ? 'admin:collectors-min' : null, () => q(supabase.from('profiles').select('id,full_name').eq('role', 'cobrador').order('full_name')));
  const data = useQuery(`expenses:${me}:${period}:${who}`, () => fetchExpenses(r, isAdmin ? who : null));
  const rows = data.data || [];
  const shown = cat ? rows.filter((x) => categoryOf(x.category).value === cat) : rows;

  // Total por categoría, de mayor a menor
  const byCat = useMemo(() => {
    const m = new Map();
    for (const x of rows) {
      const c = categoryOf(x.category).value;
      m.set(c, (m.get(c) || 0) + Number(x.amount));
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const total = byCat.reduce((s, [, v]) => s + v, 0);
  const max = Math.max(1, ...byCat.map(([, v]) => v));

  // Por cobrador (solo admin, cuando ve a todos)
  const byWho = useMemo(() => {
    if (!isAdmin || who) return [];
    const m = new Map();
    for (const x of rows) {
      const k = x.collector?.full_name || 'Gastos de la ruta (tú)';
      m.set(k, (m.get(k) || 0) + Number(x.amount));
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows, who]);

  const groups = [];
  for (const x of shown) {
    if (!groups.length || groups[groups.length - 1].d !== x.expense_date) groups.push({ d: x.expense_date, items: [], total: 0 });
    const g = groups[groups.length - 1];
    g.items.push(x);
    g.total += Number(x.amount);
  }

  return (
    <>
      <PageHeader title="Gastos operativos" eyebrow={isAdmin ? 'De la ruta y los cobradores' : 'Tus gastos de la ruta'} actions={<Button size="sm" icon="plus" onClick={() => setOpen(true)}>Gasto</Button>} />
      <div class="toolbar" data-enter>
        <Pills label="Periodo" value={period} onChange={setPeriod} options={PERIODS} />
        {isAdmin && (
          <Select label="De quién" value={who} onChange={(e) => setWho(e.currentTarget.value)}>
            <option value="">Todos</option>
            <option value="ruta">Gastos de la ruta (tú)</option>
            {(people.data || []).map((p) => <option value={p.id}>{p.full_name}</option>)}
          </Select>
        )}
      </div>

      {isAdmin && <SueldosCard />}

      <section class="expense-summary" data-enter>
        <div class="expense-total">
          <span>Total gastado · {fmtDate(r[0], { day: 'numeric', month: 'short' })} al {fmtDate(r[1], { day: 'numeric', month: 'short' })}</span>
          <b class="num">{cop(total)}</b>
          <span class="muted">{rows.length} gasto{rows.length === 1 ? '' : 's'}</span>
        </div>
        {byCat.length > 0 && (
          <div class="cat-bars">
            {byCat.map(([c, v]) => {
              const meta = categoryOf(c);
              return (
                <button type="button" class={`cat-bar ${cat === c ? 'is-active' : ''}`} onClick={() => setCat(cat === c ? '' : c)} aria-pressed={cat === c}>
                  <span class="cat-bar-label"><Icon name={meta.icon} size={15} /> {c}</span>
                  <span class="cat-bar-track"><span style={{ transform: `scaleX(${v / max})` }} /></span>
                  <b class="num">{cop(v)}</b>
                </button>
              );
            })}
          </div>
        )}
        {byWho.length > 1 && (
          <div class="who-list">
            {byWho.map(([k, v]) => <div><span>{k}</span><b class="num">{cop(v)}</b></div>)}
          </div>
        )}
      </section>

      {cat && (
        <div data-enter>
          <button type="button" class="chip is-active" onClick={() => setCat('')}>{cat} <Icon name="x" size={14} /></button>
        </div>
      )}

      {data.loading && !data.data ? (
        <div class="list-card">{[1, 2, 3].map(() => <div class="row"><Skeleton h={40} w={40} r={14} /><div class="row-main"><Skeleton w="50%" /><Skeleton w="30%" h={12} /></div></div>)}</div>
      ) : data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : !shown.length ? (
        <Empty icon="cash" title="Sin gastos en este periodo" action={<Button icon="plus" onClick={() => setOpen(true)}>Registrar gasto</Button>}>
          Registra la gasolina, el mecánico o cualquier imprevisto para que el cuadre salga bien.
        </Empty>
      ) : (
        <div class="move-days">
          {groups.map((g) => {
            const d = fmtDate(g.d, { weekday: 'long', day: 'numeric', month: 'long' });
            return (
              <section class="move-day" data-enter>
                <h3 class="day-head"><span>{d.charAt(0).toUpperCase() + d.slice(1)}</span><span class="num">{cop(g.total)}</span></h3>
                <div class="list-card">
                  {g.items.map((x) => {
                    const meta = categoryOf(x.category);
                    return (
                      <button type="button" class="row row-button" onClick={() => setDetail(x)}>
                        <span class="row-icon tone-bg-coral"><Icon name={meta.icon} size={18} /></span>
                        <div class="row-main">
                          <span class="row-title">{x.category}{x.description ? ` · ${x.description}` : ''}</span>
                          <span class="row-sub">{isAdmin ? x.collector?.full_name || 'Gasto de la ruta' : fmtTime(x.created_at)}{x.receipt_path ? ' · con recibo' : ''}</span>
                        </div>
                        <b class="num move-out">−{cop(x.amount)}</b>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Sheet open={!!detail} onClose={() => setDetail(null)} title={detail ? detail.category : ''} subtitle={detail ? `${fmtDate(detail.expense_date, { weekday: 'long', day: 'numeric', month: 'long' })}${detail.collector?.full_name ? ' · ' + detail.collector.full_name : ''}` : ''}>
        {detail && (
          <div class="form">
            <div class="receipt-amount" data-enter><span>Valor</span><b class="num">{cop(detail.amount)}</b></div>
            {detail.description && <p data-enter>{detail.description}</p>}
            <p class="muted" data-enter>Registrado el {fmtDate(detail.created_at, { day: 'numeric', month: 'long' })} a las {fmtTime(detail.created_at)}. {detail.kind === 'fijo_admin' ? 'Salió de la caja del administrador.' : 'Salió de la caja del cobrador.'}</p>
            <ReceiptPhoto path={detail.receipt_path} />
            {!detail.receipt_path && <p class="field-hint">Sin foto del recibo.</p>}
          </div>
        )}
      </Sheet>
      <GastoSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
