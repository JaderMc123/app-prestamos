import { useMemo, useState } from 'preact/hooks';
import { PageHeader } from '../../components/Shell.jsx';
import { Empty, ErrorState, Field, Pills } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { RouteRow, RouteSkeleton } from './RouteList.jsx';
import { openCobrar } from './sheets.js';

// Ruta completa del cobrador con filtros por estado
const FILTERS = [
  { value: 'todos', label: 'Todos' },
  { value: 'hoy', label: 'Cobrar hoy', match: ['hoy', 'vence'] },
  { value: 'atrasado', label: 'Atrasados', match: ['atrasado'] },
  { value: 'mora', label: 'En mora', match: ['mora'] },
  { value: 'pagado', label: 'Pagaron', match: ['pagado'] }
];

export function Ruta({ route }) {
  const [filter, setFilter] = useState('todos');
  const [term, setTerm] = useState('');
  const items = route.data?.items || [];

  const counts = useMemo(() => {
    const c = {};
    for (const f of FILTERS) c[f.value] = f.match ? items.filter((i) => f.match.includes(i.state)).length : items.length;
    return c;
  }, [items]);

  const list = useMemo(() => {
    const f = FILTERS.find((x) => x.value === filter);
    const t = term.trim().toLowerCase();
    return items.filter((i) => (!f.match || f.match.includes(i.state)) && (!t || i.client.full_name.toLowerCase().includes(t) || i.client.address?.toLowerCase().includes(t)));
  }, [items, filter, term]);

  return (
    <>
      <PageHeader title="Mi ruta" />
      <div class="toolbar" data-enter>
        <Field label="Buscar" class="toolbar-search" value={term} onInput={(e) => setTerm(e.currentTarget.value)} placeholder="Nombre o dirección" prefix={<Icon name="search" size={18} />} />
        <Pills label="Filtrar ruta" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ ...f, count: counts[f.value] }))} />
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
            {list.map((i) => (
              <RouteRow item={i} onClick={openCobrar} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
