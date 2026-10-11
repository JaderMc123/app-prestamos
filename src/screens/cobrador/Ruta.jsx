import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session } from '../../lib/session.js';
import { message } from '../../lib/api.js';
import { useQuery } from '../../lib/query.js';
import { getPosition, distanceKm } from '../../lib/geo.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Button, Empty, ErrorState, Field, Pills } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { toast } from '../../components/Toast.jsx';
import { RouteRow, RouteSkeleton } from './RouteList.jsx';
import { openCobrar } from './sheets.js';
import { fetchRouteOrder, saveRouteOrder } from './data.js';

// Ruta completa del cobrador: filtros por estado y orden por urgencia, cercanía o su propio orden
const FILTERS = [
  { value: 'todos', label: 'Todos' },
  { value: 'hoy', label: 'Cobrar hoy', match: ['hoy', 'vence'] },
  { value: 'atrasado', label: 'Atrasados', match: ['atrasado'] },
  { value: 'mora', label: 'En mora', match: ['mora'] },
  { value: 'pagado', label: 'Pagaron', match: ['pagado'] }
];

const ORDERS = [
  { value: 'urgencia', label: 'Urgencia' },
  { value: 'cercania', label: 'Cercanía' },
  { value: 'mio', label: 'Mi orden' }
];

const ORDER_KEY = 'orden-ruta';

export function Ruta({ route }) {
  const ctx = useStore(session, (s) => s.ctx);
  const userId = useStore(session, (s) => s.user?.id);
  const [filter, setFilter] = useState('todos');
  const [term, setTerm] = useState('');
  const [order, setOrder] = useState(() => {
    try {
      return localStorage.getItem(ORDER_KEY) || 'urgencia';
    } catch {
      return 'urgencia';
    }
  });
  const [here, setHere] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const saved = useQuery(`route:order:${userId}`, () => fetchRouteOrder(userId), { persist: true });
  const items = route.data?.items || [];

  useEffect(() => {
    try {
      localStorage.setItem(ORDER_KEY, order);
    } catch {}
    if (order === 'cercania' && !here) {
      getPosition()
        .then(setHere)
        .catch((err) => {
          toast(err.message, 'error');
          setOrder('urgencia');
        });
    }
  }, [order]);

  const counts = useMemo(() => {
    const c = {};
    for (const f of FILTERS) c[f.value] = f.match ? items.filter((i) => f.match.includes(i.state)).length : items.length;
    return c;
  }, [items]);

  const list = useMemo(() => {
    const f = FILTERS.find((x) => x.value === filter);
    const t = term.trim().toLowerCase();
    let out = items.filter((i) => (!f.match || f.match.includes(i.state)) && (!t || i.client.full_name.toLowerCase().includes(t) || (i.client.address || '').toLowerCase().includes(t) || (i.client.neighborhood || '').toLowerCase().includes(t)));
    if (order === 'cercania' && here) {
      const dist = (i) => distanceKm(here, { lat: Number(i.client.latitude), lng: Number(i.client.longitude) });
      out = [...out].sort((a, b) => dist(a) - dist(b));
    } else if (order === 'mio') {
      const pos = new Map((editing ? draft : saved.data || []).map((id, n) => [id, n]));
      out = [...out].sort((a, b) => (pos.get(a.id) ?? 1e6) - (pos.get(b.id) ?? 1e6));
    }
    return out;
  }, [items, filter, term, order, here, saved.data, editing, draft]);

  const startEdit = () => {
    setFilter('todos');
    setTerm('');
    setDraft(list.map((i) => i.id));
    setEditing(true);
  };

  const move = (id, dir) => {
    const next = [...draft];
    const i = next.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  };

  const saveOrder = async () => {
    try {
      await saveRouteOrder(userId, ctx.organization.id, draft);
      saved.reload();
      setEditing(false);
      toast('Orden de la ruta guardado');
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  return (
    <>
      <PageHeader title="Mi ruta" />
      <div class="toolbar" data-enter>
        <Field label="Buscar" class="toolbar-search" value={term} onInput={(e) => setTerm(e.currentTarget.value)} placeholder="Nombre, dirección o barrio" prefix={<Icon name="search" size={18} />} />
        <Pills label="Filtrar ruta" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ ...f, count: counts[f.value] }))} />
      </div>
      <div class="order-bar" data-enter>
        <span class="muted order-label">Ordenar</span>
        <Pills label="Ordenar ruta" value={order} onChange={(v) => !editing && setOrder(v)} options={ORDERS} />
        {order === 'mio' && !editing && <Button size="sm" variant="ghost" icon="settings" onClick={startEdit}>Organizar</Button>}
        {editing && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
            <Button size="sm" icon="check" onClick={saveOrder}>Guardar orden</Button>
          </>
        )}
      </div>
      <section class="paper-panel paper-flat" data-enter>
        {route.loading && !route.data ? (
          <RouteSkeleton rows={6} />
        ) : route.error && !route.data ? (
          <ErrorState error={route.error} onRetry={route.reload} />
        ) : !list.length ? (
          <Empty icon="route" title={items.length ? 'Nadie en este filtro' : 'Tu ruta está vacía'}>
            {items.length ? 'Prueba con otro filtro.' : 'Cuando tengas préstamos activos aparecerán aquí.'}
          </Empty>
        ) : (
          <div class="route-list">
            {list.map((i, n) =>
              editing ? (
                <div class="route-row is-editing" key={i.id}>
                  <span class="order-num num">{n + 1}</span>
                  <div class="route-main">
                    <span class="route-name">{i.client.full_name}</span>
                    <span class="route-sub"><span class="route-state">{i.client.neighborhood || i.client.address || ''}</span></span>
                  </div>
                  <button type="button" class="order-btn" aria-label="Subir" disabled={n === 0} onClick={() => move(i.id, -1)}><Icon name="up" size={18} /></button>
                  <button type="button" class="order-btn" aria-label="Bajar" disabled={n === list.length - 1} onClick={() => move(i.id, 1)}><Icon name="down" size={18} /></button>
                </div>
              ) : (
                <RouteRow item={i} onClick={openCobrar} key={i.id} />
              )
            )}
          </div>
        )}
      </section>
    </>
  );
}
