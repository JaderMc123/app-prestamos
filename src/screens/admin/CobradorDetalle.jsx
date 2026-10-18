import { useMemo, useState } from 'preact/hooks';
import { rpc } from '../../lib/api.js';
import { useQuery } from '../../lib/query.js';
import { Link } from '../../lib/router.jsx';
import { cop } from '../../lib/money.js';
import { timeAgo } from '../../lib/dates.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Money } from '../../components/Money.jsx';
import { Empty, ErrorState, Pills, Skeleton } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { RouteRow, RouteSkeleton } from '../cobrador/RouteList.jsx';
import { fetchRoute } from '../cobrador/data.js';
import { CollectorManage, fetchCollectors } from './Cobradores.jsx';

// Acá el admin ve todo de un cobrador: lo recaudado hoy, quién pagó, quién falta, su caja y su configuración
const PENDING = ['mora', 'atrasado', 'hoy', 'vence'];

export function CobradorDetalle({ params }) {
  const id = params.id;
  const list = useQuery('admin:collectors', fetchCollectors, { persist: true });
  const overview = useQuery('admin:overview', () => rpc('admin_overview'), { persist: true });
  const route = useQuery(`admin:route:${id}`, () => fetchRoute(id));
  const [tab, setTab] = useState('clientes');
  const [filter, setFilter] = useState('pendientes');

  const collector = (list.data || []).find((c) => c.id === id);
  const live = (overview.data?.collectors || []).find((c) => c.id === id);
  const r = route.data;
  const items = r?.items || [];

  const groups = useMemo(() => {
    const pending = items.filter((i) => PENDING.includes(i.state));
    const paid = items.filter((i) => i.paidToday > 0);
    const late = items.filter((i) => i.state === 'mora' || i.state === 'atrasado');
    const today = new Set([...pending, ...paid].map((i) => i.id)).size;
    return { pending, paid, late, today, all: items };
  }, [items]);

  const shown = filter === 'pendientes' ? groups.pending : filter === 'pagaron' ? groups.paid : filter === 'atrasados' ? groups.late : groups.all;
  const pct = r?.goal > 0 ? Math.min(1, r.collectedToday / r.goal) : 0;
  const balance = items.reduce((s, i) => s + i.balance, 0);

  if (list.data && !collector) {
    return (
      <>
        <PageHeader title="Cobrador" back="/cobradores" />
        <Empty icon="users" title="No encontramos este cobrador" />
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow={collector ? `${collector.username}, visto ${timeAgo(collector.last_seen_at).toLowerCase()}` : 'Cobrador'} title={collector?.full_name || 'Cargando…'} back="/cobradores" />

      <section class="hero collector-hero" data-enter>
        <div class="hero-label"><span>Recaudado hoy</span></div>
        {r ? <Money value={r.collectedToday} /> : <Skeleton h={56} w="60%" r={16} />}
        <span class="goal-bar" aria-hidden="true"><span style={{ transform: `scaleX(${pct})` }} /></span>
        {r && (
          <p class="hero-split muted">
            <span>Meta del día {cop(r.goal)}</span>
            <span>Falta {cop(r.remaining)}</span>
          </p>
        )}
      </section>

      <div class="kpi-grid" data-enter>
        <article class="kpi">
          <span class="kpi-icon tone-bg-lime"><Icon name="check" size={18} /></span>
          <p class="kpi-num num">{r ? groups.paid.length : '–'}<span class="kpi-of">/ {r ? groups.today : '–'}</span></p>
          <span class="kpi-label">Clientes que pagaron hoy</span>
        </article>
        <article class="kpi">
          <span class="kpi-icon tone-bg-coral"><Icon name="alert" size={18} /></span>
          <p class="kpi-num num">{r ? groups.late.length : '–'}</p>
          <span class="kpi-label">Atrasados o en mora</span>
        </article>
        <article class="kpi">
          <span class="kpi-icon tone-bg-lav"><Icon name="wallet" size={18} /></span>
          <Money value={Number(live?.cash || 0)} size="md" />
          <span class="kpi-label">Caja del cobrador</span>
        </article>
        <article class="kpi">
          <span class="kpi-icon tone-bg-amber"><Icon name="route" size={18} /></span>
          <Money value={balance} size="md" />
          <span class="kpi-label">Por cobrar en total ({items.length} préstamos)</span>
        </article>
      </div>
      {r?.pendingTransfers > 0 && (
        <p class="banner banner-lav" data-enter><Icon name="transfer" size={18} /><span>{r.pendingTransfers} transferencia{r.pendingTransfers === 1 ? '' : 's'} de hoy por verificar.</span></p>
      )}

      <div data-enter>
        <Pills label="Sección" value={tab} onChange={setTab} options={[{ value: 'clientes', label: 'Clientes' }, { value: 'caja', label: 'Caja y cuadre' }, { value: 'config', label: 'Configuración' }]} />
      </div>

      {tab === 'clientes' && (
        <>
          <div class="toolbar" data-enter>
            <Pills
              label="Filtrar clientes"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'pendientes', label: 'Faltan por cobrar', count: groups.pending.length },
                { value: 'pagaron', label: 'Pagaron hoy', count: groups.paid.length },
                { value: 'atrasados', label: 'Atrasados', count: groups.late.length },
                { value: 'todos', label: 'Todos', count: items.length }
              ]}
            />
          </div>
          <section class="paper-panel paper-flat" data-enter>
            {route.loading && !r ? (
              <RouteSkeleton rows={5} />
            ) : route.error && !r ? (
              <ErrorState error={route.error} onRetry={route.reload} />
            ) : !shown.length ? (
              <Empty icon="route" title={items.length ? 'Nadie en este filtro' : 'Sin préstamos activos'}>
                {filter === 'pendientes' && items.length ? 'Ya cobró a todos los de hoy.' : null}
              </Empty>
            ) : (
              <div class="route-list">
                {shown.map((i) => <RouteRow item={i} onClick={() => {}} key={i.id} />)}
              </div>
            )}
          </section>
        </>
      )}

      {tab === 'caja' && <Link href={`/movimientos/${id}`} class="hero-link" data-enter><Icon name="logs" size={16} /> Ver todos sus movimientos y cuadres</Link>}
      {tab !== 'clientes' && collector && <CollectorManage collector={collector} part={tab} key={tab} />}
    </>
  );
}
