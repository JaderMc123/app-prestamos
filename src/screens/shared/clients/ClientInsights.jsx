import { useMemo, useState } from 'preact/hooks';
import { cop } from '../../../lib/money.js';
import { fmtDate, fmtTime } from '../../../lib/dates.js';
import { Avatar, Empty, Pills, Skeleton } from '../../../components/ui.jsx';
import { Icon } from '../../../components/Icon.jsx';
import { CONCEPT, LEVELS } from './insights.js';

// Acá se muestran el puntaje del cliente, su historial de pagos y el ranking de clientes
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

export function ScoreBadge({ ins, size = 'md' }) {
  if (!ins) return null;
  const lv = LEVELS[ins.level];
  return (
    <span class={`score-badge score-${size} tone-ring-${lv.tone}`} title={lv.label}>
      <b class="num">{ins.level === 'nuevo' ? '—' : ins.score}</b>
      {size !== 'sm' && <span>{lv.label}</span>}
    </span>
  );
}

function LoadError({ onRetry }) {
  return (
    <div class="banner banner-amber" data-enter>
      <Icon name="alert" size={18} />
      <span>No se pudo cargar el historial. Revisa tu conexión.</span>
      {onRetry && <button type="button" class="link-btn" onClick={onRetry}>Reintentar</button>}
    </div>
  );
}

export function ScoreCard({ ins, error, onRetry }) {
  if (!ins) return error ? <LoadError onRetry={onRetry} /> : <Skeleton h={150} r={22} />;
  const lv = LEVELS[ins.level];
  return (
    <section class={`score-card score-card-${lv.tone}`} data-enter>
      <div class="score-top">
        <div class="score-ring" style={{ '--p': ins.level === 'nuevo' ? 0 : ins.score / 100 }}>
          <b class="num">{ins.level === 'nuevo' ? '—' : ins.score}</b>
        </div>
        <div>
          <p class="score-level">{lv.label}</p>
          <p class="score-advice"><Icon name={ins.offer ? 'check' : lv.icon} size={16} /> {ins.offer ? 'Buen momento para ofrecerle' : lv.advice}</p>
        </div>
      </div>
      <div class="score-stats">
        <div><span>Paga a tiempo</span><b class="num">{pct(ins.punctuality)}</b></div>
        <div><span>Atraso promedio</span><b class="num">{ins.lateCount ? `${ins.avgLate} día${ins.avgLate === 1 ? '' : 's'}` : '0'}</b></div>
        <div><span>Préstamos</span><b class="num">{ins.loans}{ins.finished ? ` (${ins.finished} pagados)` : ''}</b></div>
        <div><span>Cayó en mora</span><b class="num">{ins.moraLoans ? `${ins.moraLoans} vez${ins.moraLoans === 1 ? '' : 'es'}` : 'Nunca'}</b></div>
        <div><span>Ganancia que dejó</span><b class="num">{cop(ins.profit)}</b></div>
        <div><span>Total pagado</span><b class="num">{cop(ins.paidTotal)}</b></div>
      </div>
    </section>
  );
}

function statusOf(p) {
  if (p.is_reversed) return { label: p.verification_status === 'rechazado' ? 'Rechazado' : 'Reversado', tone: 'coral', off: true };
  if (p.verification_status === 'pendiente') return { label: 'Por verificar', tone: 'amber' };
  return null;
}

export function PaymentHistory({ ins, error, onRetry }) {
  const [show, setShow] = useState(30);
  if (!ins) return error ? <LoadError onRetry={onRetry} /> : <Skeleton h={200} r={22} />;
  const list = ins.payments;
  if (!list.length) return <Empty icon="cash" title="Sin pagos todavía">Aquí aparecerá cada abono que haga el cliente.</Empty>;

  // Agrupados por mes para leerlos fácil
  const groups = [];
  for (const p of list.slice(0, show)) {
    const raw = fmtDate(p.paid_at, { month: 'long', year: 'numeric' });
    const m = raw.charAt(0).toUpperCase() + raw.slice(1);
    if (!groups.length || groups[groups.length - 1].m !== m) groups.push({ m, items: [], total: 0 });
    const g = groups[groups.length - 1];
    g.items.push(p);
    if (!p.is_reversed) g.total += Number(p.amount);
  }

  return (
    <div class="pay-history" data-enter>
      {groups.map((g) => (
        <section class="pay-month">
          <header><span>{g.m}</span><b class="num">{cop(g.total)}</b></header>
          <div class="list-card list-flat">
            {g.items.map((p) => {
              const st = statusOf(p);
              return (
                <div class={`row pay-row ${st?.off ? 'is-off' : ''}`}>
                  <span class={`row-icon ${p.method === 'transferencia' ? 'tone-bg-lav' : 'tone-bg-lime'}`}><Icon name={p.method === 'transferencia' ? 'transfer' : 'cash'} size={17} /></span>
                  <div class="row-main">
                    <span class="row-title">{CONCEPT[p.concept] || 'Cuota'}{p.method === 'transferencia' ? ' · Transferencia' : p.method === 'efectivo' ? ' · Efectivo' : ''}</span>
                    <span class="row-sub">{fmtDate(p.paid_at, { weekday: 'short', day: 'numeric', month: 'short' })}, {fmtTime(p.paid_at)}{p.notes && p.concept === 'cuota' ? ` · ${p.notes}` : ''}</span>
                  </div>
                  <div class="pay-amount">
                    <b class="num">{cop(p.amount)}</b>
                    {st && <span class={`tag tag-${st.tone}`}>{st.label}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {list.length > show && <button type="button" class="link-btn center" onClick={() => setShow(show + 30)}>Ver pagos anteriores ({list.length - show})</button>}
    </div>
  );
}

// Ranking: a quién ofrecerle, quién deja más ganancia, quién paga tarde y a quién no prestarle
const SEGMENTS = [
  { value: 'ofrecer', label: 'Para ofrecer', icon: 'check', empty: 'Cuando tus clientes paguen a tiempo aparecerán aquí. Primero salen los que ya casi terminan su préstamo.' },
  { value: 'ganancia', label: 'Más ganancia', icon: 'chart', empty: 'Aún no hay ganancias registradas.' },
  { value: 'tarde', label: 'Pagan tarde', icon: 'calendar', empty: 'Nadie paga tarde. ¡Bien!' },
  { value: 'riesgo', label: 'No prestar', icon: 'lock', empty: 'No hay clientes riesgosos.' }
];

export function Ranking({ clients, insights, loading, error, onRetry, onSelect }) {
  const [seg, setSeg] = useState('ofrecer');
  const rows = useMemo(() => clients.map((c) => ({ c, i: insights?.get(c.id) })).filter((r) => r.i), [clients, insights]);
  const counts = useMemo(() => {
    const k = { excelente: 0, bueno: 0, nuevo: 0, regular: 0, malo: 0 };
    rows.forEach((r) => k[r.i.level]++);
    return k;
  }, [rows]);

  const list = useMemo(() => {
    if (seg === 'ofrecer') return rows.filter((r) => r.i.good).sort((a, b) => Number(b.i.offer) - Number(a.i.offer) || b.i.score - a.i.score || b.i.profit - a.i.profit);
    if (seg === 'ganancia') return rows.filter((r) => r.i.profit > 0).sort((a, b) => b.i.profit - a.i.profit);
    if (seg === 'tarde') return rows.filter((r) => r.i.lateCount > 0 && r.i.level !== 'malo').sort((a, b) => (a.i.punctuality ?? 1) - (b.i.punctuality ?? 1) || b.i.avgLate - a.i.avgLate);
    return rows.filter((r) => r.i.level === 'malo').sort((a, b) => a.i.score - b.i.score);
  }, [rows, seg]);

  const meta = SEGMENTS.find((s) => s.value === seg);
  const maxProfit = Math.max(1, ...rows.map((r) => r.i.profit));

  return (
    <>
      <div class="level-strip" data-enter>
        {['excelente', 'bueno', 'regular', 'malo'].map((k) => (
          <div class={`level-chip tone-ring-${LEVELS[k].tone}`}>
            <b class="num">{counts[k]}</b>
            <span>{LEVELS[k].label}</span>
          </div>
        ))}
      </div>
      <div class="toolbar" data-enter>
        <Pills label="Ver" value={seg} onChange={setSeg} options={SEGMENTS.map((s) => ({ value: s.value, label: s.label }))} />
      </div>
      <section class="paper-panel paper-flat" data-enter>
        {error && !insights ? (
          <div class="pad-16"><LoadError onRetry={onRetry} /></div>
        ) : loading && !insights ? (
          <div class="route-list">{[1, 2, 3, 4].map(() => <div class="route-row"><Skeleton w={44} h={44} r={22} class="sk-paper" /><div class="route-main"><Skeleton w="50%" class="sk-paper" /><Skeleton w="70%" h={10} class="sk-paper" /></div></div>)}</div>
        ) : !list.length ? (
          <Empty icon={meta.icon} title="Nadie por ahora">{meta.empty}</Empty>
        ) : (
          <div class="route-list">
            {list.map(({ c, i }, n) => (
              <button type="button" class="route-row" onClick={() => onSelect(c)} key={c.id}>
                <span class="rank-num num">{n + 1}</span>
                <Avatar name={c.full_name} tone="paper" size={40} />
                <div class="route-main">
                  <span class="route-name">{c.full_name}</span>
                  <span class="route-sub">
                    {seg === 'ganancia' ? (
                      <span class="rank-bar"><span style={{ transform: `scaleX(${i.profit / maxProfit})` }} /></span>
                    ) : seg === 'tarde' ? (
                      <span>A tiempo {pct(i.punctuality)} · atraso promedio {i.avgLate} día{i.avgLate === 1 ? '' : 's'}</span>
                    ) : seg === 'riesgo' ? (
                      <span>{i.inMora ? 'En mora ahora · ' : ''}{i.moraLoans ? `Cayó en mora ${i.moraLoans} vez${i.moraLoans === 1 ? '' : 'es'}` : `A tiempo ${pct(i.punctuality)}`}</span>
                    ) : (
                      <span>{i.offer ? <b class="ready">Listo para otro préstamo</b> : `Va en ${pct(i.progress)}`} · a tiempo {pct(i.punctuality)}</span>
                    )}
                  </span>
                </div>
                <div class="route-amount num">
                  {seg === 'ganancia' || seg === 'ofrecer' ? cop(i.profit) : <ScoreBadge ins={i} size="sm" />}
                  {(seg === 'ganancia' || seg === 'ofrecer') && <span class="route-overdue is-soft">de ganancia</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
      <p class="muted center rank-note" data-enter>El puntaje va de 0 a 100: sube cuando paga a tiempo y termina sus préstamos, y baja con los atrasos y la mora.</p>
    </>
  );
}
