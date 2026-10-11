import { useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session } from '../../lib/session.js';
import { rpc } from '../../lib/api.js';
import { useQuery } from '../../lib/query.js';
import { Link } from '../../lib/router.jsx';
import { greeting, timeAgo, fmtDate } from '../../lib/dates.js';
import { cop } from '../../lib/money.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Money } from '../../components/Money.jsx';
import { AreaChart } from '../../components/AreaChart.jsx';
import { Avatar, Empty, ErrorState, Pills, Skeleton } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';

// Inicio del administrador: capital, cobrado del día, gráfica mensual y cobradores en vivo
const SERIES = {
  cobrado: { name: 'Cobrado', color: 'var(--lime)' },
  prestado: { name: 'Prestado', color: 'var(--lav)' },
  ganancia: { name: 'Ganancia', color: 'var(--lime)' }
};

export function Dashboard() {
  const ctx = useStore(session, (s) => s.ctx);
  const [view, setView] = useState('todo');
  const overview = useQuery('admin:overview', () => rpc('admin_overview'), { persist: true });
  const summary = useQuery('admin:summary', () => rpc('get_capital_summary'), { persist: true });
  const o = overview.data;
  const s = summary.data;
  const months = o?.months || [];
  const labels = months.map((m) => fmtDate(m.month + '-15', { month: 'short' }));
  const series = view === 'todo' ? [SERIES.cobrado, SERIES.prestado].map((x, i) => ({ ...x, values: months.map((m) => Number(i ? m.prestado : m.cobrado)) })) : [{ ...SERIES[view], values: months.map((m) => Number(m[view])) }];
  const total = s ? Number(s.capital_liquido_total) + Number(s.capital_en_calle_total) : 0;
  const thisMonth = Number(months[months.length - 1]?.ganancia || 0);
  const lastMonth = Number(months[months.length - 2]?.ganancia || 0);
  const delta = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100 : null;

  return (
    <div class="home-grid">
      <div class="home-main">
        <PageHeader eyebrow={greeting() + ','} title={ctx.full_name.split(' ')[0]} />

        <section class="hero" data-enter>
          <div class="hero-label"><span>Capital total</span></div>
          {s ? <Money value={total} /> : <Skeleton h={56} w="70%" r={16} />}
          {s && (
            <p class="hero-split muted">
              <span><i class="legend-dot" style={{ background: 'var(--lime)' }} />Disponible {cop(s.capital_liquido_total)}</span>
              <span><i class="legend-dot" style={{ background: 'var(--lav)' }} />En la calle {cop(s.capital_en_calle_total)}</span>
            </p>
          )}
        </section>

        <div data-enter>
          <Pills label="Ver gráfica" value={view} onChange={setView} options={[{ value: 'todo', label: 'Todo' }, { value: 'cobrado', label: 'Cobrado' }, { value: 'prestado', label: 'Prestado' }, { value: 'ganancia', label: 'Ganancia' }]} />
        </div>

        <section class="chart-card" data-enter>
          {months.length ? <AreaChart labels={labels} series={series} /> : <Skeleton h={220} r={20} />}
        </section>

        <div class="kpi-grid" data-enter>
          <article class="kpi">
            <span class="kpi-icon tone-bg-lime"><Icon name="down" size={18} /></span>
            <Money value={o?.today_collected || 0} size="md" />
            <span class="kpi-label">Cobrado hoy</span>
          </article>
          <article class="kpi">
            <span class="kpi-icon tone-bg-lav"><Icon name="calendar" size={18} /></span>
            <Money value={o?.today_due || 0} size="md" />
            <span class="kpi-label">Falta por cobrar hoy</span>
          </article>
          <article class="kpi">
            <span class="kpi-icon tone-bg-amber"><Icon name="transfer" size={18} /></span>
            <p class="kpi-num num">{o?.pending_transfers ?? '–'}</p>
            <span class="kpi-label">Transferencias por verificar</span>
          </article>
          <article class="kpi">
            <span class="kpi-icon tone-bg-coral"><Icon name="alert" size={18} /></span>
            <p class="kpi-num num">{o?.overdue_loans ?? '–'}<span class="kpi-of">/ {o?.active_loans ?? '–'}</span></p>
            <span class="kpi-label">Préstamos en mora</span>
          </article>
        </div>

        <article class="insight" data-enter>
          <div>
            <p class="insight-big num">
              {delta == null ? cop(thisMonth) : `${delta >= 0 ? '+' : ''}${delta.toFixed(1).replace('.', ',')}%`}
              {delta != null && <Icon name={delta >= 0 ? 'up' : 'down'} size={20} stroke={2.2} />}
            </p>
            <p>{delta == null ? 'Ganancia cobrada este mes' : `Ganancia de este mes frente al anterior (${cop(thisMonth)})`}</p>
          </div>
          <div class="insight-side">
            <span>Por cobrar a futuro</span>
            <b class="num">{cop(o?.projected_profit || 0)}</b>
          </div>
        </article>
      </div>

      <section class="paper-panel" data-enter aria-labelledby="cobradores-hoy">
        <span class="paper-grab only-mobile" aria-hidden="true" />
        <div class="paper-head">
          <h2 id="cobradores-hoy">Cobradores hoy</h2>
          <Link href="/cobradores" class="paper-link">Gestionar</Link>
        </div>
        {overview.loading && !o ? (
          <div class="route-list">{[1, 2, 3].map(() => <div class="route-row"><Skeleton w={44} h={44} r={22} class="sk-paper" /><div class="route-main"><Skeleton w="50%" class="sk-paper" /><Skeleton w="80%" h={8} class="sk-paper" /></div></div>)}</div>
        ) : overview.error && !o ? (
          <ErrorState error={overview.error} onRetry={overview.reload} />
        ) : !o.collectors.length ? (
          <Empty icon="users" title="Aún no tienes cobradores" action={<Link href="/cobradores" class="btn btn-lime btn-sm">Crear cobrador</Link>}>
            Crea el primero para asignarle capital y clientes.
          </Empty>
        ) : (
          <div class="route-list">
            {o.collectors.map((c) => {
              const goal = Number(c.collected_today) + Number(c.due_today);
              const pct = goal > 0 ? Math.min(1, c.collected_today / goal) : 0;
              return (
                <Link href="/cobradores" class="route-row" data-enter>
                  <Avatar name={c.full_name} tone="paper" size={44} />
                  <div class="route-main">
                    <span class="route-name">{c.full_name}</span>
                    <span class="mini-progress"><span style={{ transform: `scaleX(${pct})` }} /></span>
                    <span class="route-sub">{c.is_active ? `Visto ${timeAgo(c.last_seen_at).toLowerCase()}` : 'Desactivado'}, caja {cop(c.cash)}</span>
                  </div>
                  <div class="route-amount num">
                    {cop(c.collected_today)}
                    <span class="route-overdue is-soft">de {cop(goal)}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
