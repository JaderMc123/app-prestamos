import { useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session } from '../../lib/session.js';
import { supabase } from '../../lib/supabase.js';
import { q } from '../../lib/api.js';
import { useQuery } from '../../lib/query.js';
import { cop } from '../../lib/money.js';
import { addDays, fmtDate, fmtTime, todayISO } from '../../lib/dates.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Sheet } from '../../components/Sheet.jsx';
import { Button, Empty, ErrorState, Pills, Select, Skeleton } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { toast } from '../../components/Toast.jsx';

// Acá queda la constancia de todo lo que pasa con la plata: cobros, capital entregado, cuadres, gastos y préstamos entregados
const PERIODS = [
  { value: '0', label: 'Hoy' },
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: '90', label: '3 meses' }
];
const KINDS = [
  { value: 'todo', label: 'Todo' },
  { value: 'cobro', label: 'Cobros' },
  { value: 'capital', label: 'Capital' },
  { value: 'cuadre', label: 'Cuadres' },
  { value: 'prestamo', label: 'Préstamos' },
  { value: 'gasto', label: 'Gastos' }
];
const CONCEPT = { cuota: 'Cobro', papeleria: 'Papelería', renovacion: 'Renovación', saldo_anterior: 'Saldo anterior' };

const since = (days) => addDays(todayISO(), -Number(days)) + 'T00:00:00-05:00';

async function fetchMovements(days, collector) {
  const from = since(days);
  const byCollector = (b, col) => (collector ? b.eq(col, collector) : b);
  const [pays, moves, closures] = await Promise.all([
    q(
      byCollector(
        supabase
          .from('payments')
          .select('id,amount,paid_at,method,concept,verification_status,is_reversed,reversal_reason,collector_id,account:payment_accounts(name),loan:loans(client:clients(full_name))')
          .neq('concept', 'saldo_anterior')
          .gte('paid_at', from)
          .order('paid_at', { ascending: false })
          .limit(400),
        'collector_id'
      )
    ),
    q(
      supabase
        .from('capital_movements')
        .select('id,type,amount,wallet_collector_id,wallet_account_id,transfer_group,cash_closure_id,note,created_at,account:payment_accounts(name),loan:loans(client:clients(full_name))')
        .not('type', 'in', '(cobro,reverso_cobro)')
        .gte('created_at', from)
        .order('created_at', { ascending: false })
        .limit(400)
    ),
    q(
      byCollector(
        supabase
          .from('cash_closures')
          .select('id,closure_date,collector_id,cash_collected,transfers_collector_accounts,transfers_org_accounts,cash_disbursed,expenses_total,cash_expected,cash_reported,difference,cash_handed_over,adjustment_applied,notes,closed_at,closer:profiles!cash_closures_closed_by_fkey(full_name)')
          .gte('closed_at', from)
          .order('closed_at', { ascending: false })
          .limit(200),
        'collector_id'
      )
    )
  ]);
  return { pays, moves, closures };
}

// Une todo en una sola línea de tiempo; los dos lados de una entrega de capital se muestran como un solo movimiento
function buildTimeline(data, { isAdmin, me, collector, names }) {
  if (!data) return [];
  const out = [];
  const name = (id) => names.get(id) || 'Cobrador';

  for (const p of data.pays) {
    out.push({
      id: 'p' + p.id,
      kind: 'cobro',
      at: p.paid_at,
      title: `${CONCEPT[p.concept] || 'Cobro'} · ${p.loan?.client?.full_name || 'Cliente'}`,
      sub: [p.method === 'transferencia' ? `Transferencia${p.account?.name ? ' a ' + p.account.name : ''}` : 'Efectivo', isAdmin && !collector ? name(p.collector_id) : null].filter(Boolean).join(' · '),
      amount: Number(p.amount),
      sign: 1,
      icon: p.method === 'transferencia' ? 'transfer' : 'cash',
      tone: p.method === 'transferencia' ? 'lav' : 'lime',
      status: p.is_reversed ? (p.verification_status === 'rechazado' ? 'Rechazado' : 'Reversado') : p.verification_status === 'pendiente' ? 'Por verificar' : null,
      off: p.is_reversed,
      raw: p
    });
  }

  const groups = new Map();
  for (const m of data.moves) {
    if (m.cash_closure_id) continue; // se muestra dentro del cuadre
    if (collector && m.wallet_collector_id !== collector && !(m.transfer_group && data.moves.some((x) => x.transfer_group === m.transfer_group && x.wallet_collector_id === collector))) continue;
    if (m.transfer_group) {
      if (!groups.has(m.transfer_group)) groups.set(m.transfer_group, []);
      groups.get(m.transfer_group).push(m);
      continue;
    }
    const amount = Math.abs(Number(m.amount));
    const who = isAdmin && m.wallet_collector_id ? ` · ${name(m.wallet_collector_id)}` : '';
    if (m.type === 'desembolso')
      out.push({ id: 'm' + m.id, kind: 'prestamo', at: m.created_at, title: `Préstamo entregado · ${m.loan?.client?.full_name || 'Cliente'}`, sub: (m.wallet_account_id ? `Transferencia desde ${m.account?.name || 'cuenta'}` : 'Efectivo') + who, amount, sign: -1, icon: 'wallet', tone: 'amber', raw: m });
    else if (m.type === 'gasto')
      out.push({ id: 'm' + m.id, kind: 'gasto', at: m.created_at, title: `Gasto · ${m.note || 'Sin detalle'}`, sub: (m.wallet_collector_id ? 'De la caja del cobrador' : 'De tu caja') + who, amount, sign: -1, icon: 'cash', tone: 'coral', raw: m });
    else if (m.type === 'aporte_base' || m.type === 'retiro')
      out.push({ id: 'm' + m.id, kind: 'capital', at: m.created_at, title: m.type === 'retiro' ? 'Retiro de la caja' : 'Aporte a la caja', sub: m.note || '', amount, sign: m.type === 'retiro' ? -1 : 1, icon: 'wallet', tone: 'lime', raw: m });
    else
      out.push({ id: 'm' + m.id, kind: 'capital', at: m.created_at, title: m.note || 'Ajuste', sub: who.replace(' · ', ''), amount, sign: Number(m.amount) < 0 ? -1 : 1, icon: 'sync', tone: 'lav', raw: m });
  }

  for (const legs of groups.values()) {
    const minus = legs.find((l) => Number(l.amount) < 0);
    const plus = legs.find((l) => Number(l.amount) > 0);
    const any = plus || minus;
    const amount = Math.abs(Number(any.amount));
    const toCollector = plus?.wallet_collector_id;
    const fromCollector = minus?.wallet_collector_id;
    let title;
    let sign;
    if (!isAdmin) {
      title = plus && plus.wallet_collector_id === me ? 'Capital recibido del administrador' : 'Devolviste capital al administrador';
      sign = plus && plus.wallet_collector_id === me ? 1 : -1;
    } else if (toCollector) {
      title = `Entregaste capital a ${name(toCollector)}`;
      sign = collector ? 1 : -1;
    } else {
      title = `${name(fromCollector)} te devolvió capital`;
      sign = collector ? -1 : 1;
    }
    out.push({ id: 'g' + any.transfer_group, kind: 'capital', at: any.created_at, title, sub: any.note && !/asignaci/i.test(any.note) ? any.note : 'Constancia de entrega', amount, sign, icon: 'transfer', tone: 'lime', raw: legs, receipt: true });
  }

  for (const c of data.closures) {
    const legs = data.moves.filter((m) => m.cash_closure_id === c.id);
    out.push({
      id: 'c' + c.id,
      kind: 'cuadre',
      at: c.closed_at,
      title: `Cuadre del ${fmtDate(c.closure_date, { day: 'numeric', month: 'short' })}${isAdmin && !collector ? ' · ' + name(c.collector_id) : ''}`,
      sub: Number(c.difference) === 0 ? 'Cuadró exacto' : Number(c.difference) < 0 ? `Faltaron ${cop(-c.difference)}` : `Sobraron ${cop(c.difference)}`,
      amount: Number(c.cash_handed_over),
      sign: isAdmin ? 1 : -1,
      icon: 'check',
      tone: Number(c.difference) < 0 ? 'amber' : 'lime',
      raw: { ...c, legs },
      receipt: true
    });
  }

  return out.sort((a, b) => new Date(b.at) - new Date(a.at));
}

// Texto de la constancia para compartir por WhatsApp o guardar
function receiptText(item, ctx, names) {
  const r = item.raw;
  const head = `${ctx.organization?.name || 'Cobros'}\nConstancia · ${fmtDate(item.at, { day: 'numeric', month: 'long', year: 'numeric' })}, ${fmtTime(item.at)}`;
  if (item.kind === 'cuadre') {
    return [
      head,
      `Cuadre de caja de ${names.get(r.collector_id) || 'cobrador'}`,
      `Cobrado en efectivo: ${cop(r.cash_collected)}`,
      `Transferencias: ${cop(Number(r.transfers_collector_accounts) + Number(r.transfers_org_accounts))}`,
      `Préstamos entregados: ${cop(r.cash_disbursed)}`,
      `Gastos: ${cop(r.expenses_total)}`,
      `Debía tener: ${cop(r.cash_expected)}`,
      `Contó: ${cop(r.cash_reported)}`,
      `Diferencia: ${cop(r.difference)}`,
      `Entregó al administrador: ${cop(r.cash_handed_over)}`,
      r.closer?.full_name ? `Cerrado por: ${r.closer.full_name}` : null
    ].filter(Boolean).join('\n');
  }
  return [head, item.title, `Valor: ${cop(item.amount)}`, item.sub].filter(Boolean).join('\n');
}

function Receipt({ item, onClose, names }) {
  const ctx = useStore(session, (s) => s.ctx);
  if (!item) return null;
  const r = item.raw;
  const text = receiptText(item, ctx, names);
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Constancia', text });
      else {
        await navigator.clipboard.writeText(text);
        toast('Constancia copiada');
      }
    } catch {}
  };
  return (
    <Sheet open={!!item} onClose={onClose} title={item.title} subtitle={`${fmtDate(item.at, { weekday: 'long', day: 'numeric', month: 'long' })}, ${fmtTime(item.at)}`}>
      <div class="form">
        <div class="receipt-amount" data-enter>
          <span>{item.kind === 'cuadre' ? 'Entregó al administrador' : 'Valor'}</span>
          <b class="num">{cop(item.amount)}</b>
          {item.status && <span class="tag tag-amber">{item.status}</span>}
        </div>
        {item.kind === 'cuadre' && (
          <div class="list-card list-flat receipt-lines" data-enter>
            {[
              ['Cobrado en efectivo', r.cash_collected],
              ['Transferencias', Number(r.transfers_collector_accounts) + Number(r.transfers_org_accounts)],
              ['Préstamos entregados', -r.cash_disbursed],
              ['Gastos', -r.expenses_total],
              ['Debía tener', r.cash_expected],
              ['Contó', r.cash_reported],
              ['Diferencia', r.difference]
            ].map(([k, v]) => (
              <div class="row"><div class="row-main"><span class="row-title">{k}</span></div><b class={`num ${k === 'Diferencia' && Number(v) < 0 ? 'text-coral' : ''}`}>{cop(v)}</b></div>
            ))}
            {r.closer?.full_name && <div class="row"><div class="row-main"><span class="row-sub">Cerrado por {r.closer.full_name}{r.adjustment_applied ? ', diferencia registrada' : ''}</span></div></div>}
            {r.notes && <div class="row"><div class="row-main"><span class="row-sub">Nota: {r.notes}</span></div></div>}
          </div>
        )}
        {item.kind !== 'cuadre' && item.sub && <p class="muted" data-enter>{item.sub}</p>}
        {item.raw?.reversal_reason && <p class="muted" data-enter>Motivo: {item.raw.reversal_reason}</p>}
        <Button size="lg" class="btn-block" icon="upload" onClick={share}>Compartir constancia</Button>
      </div>
    </Sheet>
  );
}

export function Movimientos({ params }) {
  const ctx = useStore(session, (s) => s.ctx);
  const me = useStore(session, (s) => s.user?.id);
  const isAdmin = ctx.role === 'admin';
  const [days, setDays] = useState('7');
  const [kind, setKind] = useState('todo');
  const [collector, setCollector] = useState(params?.collector || '');
  const [open, setOpen] = useState(null);

  const people = useQuery(isAdmin ? 'admin:collectors-min' : null, () => q(supabase.from('profiles').select('id,full_name').eq('role', 'cobrador').order('full_name')));
  const names = useMemo(() => new Map([...(people.data || []).map((p) => [p.id, p.full_name]), [me, ctx.full_name]]), [people.data, me]);
  const data = useQuery(`${isAdmin ? 'admin:' : ''}movements:${me}:${days}:${collector}`, () => fetchMovements(days, isAdmin ? collector || null : null));
  const timeline = useMemo(() => buildTimeline(data.data, { isAdmin, me, collector: isAdmin ? collector || null : me, names }), [data.data, names, collector]);
  const list = kind === 'todo' ? timeline : timeline.filter((i) => i.kind === kind);

  // Totales del periodo
  const totals = useMemo(() => {
    const t = { cobrado: 0, capital: 0, cuadres: 0, gastos: 0 };
    for (const i of timeline) {
      if (i.off) continue;
      if (i.kind === 'cobro') t.cobrado += i.amount;
      // Capital que el admin le dio al cobrador (visto desde cada lado)
      if (i.kind === 'capital' && i.receipt && (isAdmin ? /^Entregaste/.test(i.title) : i.sign > 0)) t.capital += i.amount;
      if (i.kind === 'cuadre') t.cuadres += i.amount;
      if (i.kind === 'gasto') t.gastos += i.amount;
    }
    return t;
  }, [timeline]);

  // Agrupado por día
  const days_ = [];
  for (const i of list) {
    const d = fmtDate(i.at, { weekday: 'long', day: 'numeric', month: 'long' });
    if (!days_.length || days_[days_.length - 1].key !== d) days_.push({ key: d, d: d.charAt(0).toUpperCase() + d.slice(1), items: [] });
    days_[days_.length - 1].items.push(i);
  }

  return (
    <>
      <PageHeader title="Movimientos" eyebrow="Constancia de todo" />
      <div class="toolbar" data-enter>
        <Pills label="Periodo" value={days} onChange={setDays} options={PERIODS} />
        {isAdmin && (
          <Select label="Cobrador" value={collector} onChange={(e) => setCollector(e.currentTarget.value)}>
            <option value="">Todos los cobradores</option>
            {(people.data || []).map((p) => <option value={p.id}>{p.full_name}</option>)}
          </Select>
        )}
      </div>

      <div class="move-totals" data-enter>
        <div><span>Cobrado</span><b class="num">{cop(totals.cobrado)}</b></div>
        <div><span>{isAdmin ? 'Capital entregado' : 'Capital recibido'}</span><b class="num">{cop(totals.capital)}</b></div>
        <div><span>{isAdmin ? 'Recibido en cuadres' : 'Entregado en cuadres'}</span><b class="num">{cop(totals.cuadres)}</b></div>
        <div><span>Gastos</span><b class="num">{cop(totals.gastos)}</b></div>
      </div>

      <div class="toolbar" data-enter>
        <Pills label="Tipo" value={kind} onChange={setKind} options={KINDS.map((k) => ({ ...k, count: k.value === 'todo' ? null : timeline.filter((i) => i.kind === k.value).length || null }))} />
      </div>

      {data.loading && !data.data ? (
        <div class="list-card">{[1, 2, 3, 4, 5].map(() => <div class="row"><Skeleton h={40} w={40} r={14} /><div class="row-main"><Skeleton w="60%" /><Skeleton w="40%" h={12} /></div></div>)}</div>
      ) : data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : !list.length ? (
        <Empty icon="logs" title="Sin movimientos">No hay movimientos en este periodo.</Empty>
      ) : (
        <div class="move-days">
          {days_.map((g) => (
            <section class="move-day" data-enter>
              <h3>{g.d}</h3>
              <div class="list-card">
                {g.items.map((i) => (
                  <button type="button" class={`row row-button ${i.off ? 'is-off' : ''}`} onClick={() => setOpen(i)}>
                    <span class={`row-icon tone-bg-${i.tone}`}><Icon name={i.icon} size={18} /></span>
                    <div class="row-main">
                      <span class="row-title">{i.title}</span>
                      <span class="row-sub">{fmtTime(i.at)}{i.sub ? ` · ${i.sub}` : ''}</span>
                    </div>
                    <div class="pay-amount">
                      <b class={`num ${i.sign < 0 ? 'move-out' : 'move-in'}`}>{i.sign < 0 ? '−' : '+'}{cop(i.amount)}</b>
                      {i.status && <span class={`tag ${i.off ? 'tag-coral' : 'tag-amber'}`}>{i.status}</span>}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <Receipt item={open} names={names} onClose={() => setOpen(null)} />
    </>
  );
}
