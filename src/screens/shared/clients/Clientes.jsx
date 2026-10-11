import { useMemo, useState } from 'preact/hooks';
import { useStore } from '../../../lib/store.js';
import { session } from '../../../lib/session.js';
import { useQuery } from '../../../lib/query.js';
import { cop } from '../../../lib/money.js';
import { PageHeader } from '../../../components/Shell.jsx';
import { Avatar, Button, Empty, ErrorState, Field, Pills, StatusDot } from '../../../components/ui.jsx';
import { Icon } from '../../../components/Icon.jsx';
import { ClientsMap } from '../../../components/Map.jsx';
import { RouteSkeleton } from '../../cobrador/RouteList.jsx';
import { CLIENT_STATE, fetchClients, fetchMyBlocks } from './data.js';
import { ClientForm } from './ClientForm.jsx';
import { ClientDetail } from './ClientDetail.jsx';
import { clientSheets } from './sheets.js';

// Lista de clientes (cobrador y admin). El admin además ve el mapa con todos sus clientes
const FILTERS = [
  { value: 'todos', label: 'Todos' },
  { value: 'activos', label: 'Con préstamo' },
  { value: 'mora', label: 'En mora o atrasados' },
  { value: 'bloqueados', label: 'No prestar' }
];

export function Clientes() {
  const ctx = useStore(session, (s) => s.ctx);
  const userId = useStore(session, (s) => s.user?.id);
  const isAdmin = ctx.role === 'admin';
  const [filter, setFilter] = useState('todos');
  const [term, setTerm] = useState('');
  const [view, setView] = useState('lista');
  const [selected, setSelected] = useState(null);
  const clients = useQuery(`clients:${userId}`, fetchClients, { persist: true });
  const blocks = useQuery(isAdmin ? null : `clients:blocks:${userId}`, () => fetchMyBlocks(userId));
  const myBlocks = new Set((blocks.data || []).map((b) => b.client_id));
  const all = clients.data || [];

  const list = useMemo(() => {
    const t = term.trim().toLowerCase();
    return all.filter((c) => {
      if (filter === 'activos' && !c.activeLoans.length) return false;
      if (filter === 'mora' && !['mora', 'atrasado'].includes(c.state)) return false;
      if (filter === 'bloqueados' && !(c.blocked_by_admin || myBlocks.has(c.id))) return false;
      return !t || c.full_name.toLowerCase().includes(t) || c.document_number.includes(t) || (c.neighborhood || '').toLowerCase().includes(t);
    });
  }, [all, filter, term, blocks.data]);

  const points = useMemo(
    () => list.map((c) => ({ id: c.id, lat: c.latitude != null ? Number(c.latitude) : null, lng: c.longitude != null ? Number(c.longitude) : null, tone: CLIENT_STATE[c.state].tone, label: c.full_name, client: c })),
    [list]
  );

  const openNew = () => clientSheets.set({ form: true, editing: null });

  const listView = (
    <section class="paper-panel paper-flat" data-enter>
      {clients.loading && !clients.data ? (
        <RouteSkeleton rows={5} />
      ) : clients.error && !clients.data ? (
        <ErrorState error={clients.error} onRetry={clients.reload} />
      ) : !list.length ? (
        <Empty icon="users" title={all.length ? 'Nadie con ese filtro' : 'Aún no hay clientes'} action={!all.length && <Button icon="plus" onClick={openNew}>Nuevo cliente</Button>}>
          {all.length ? 'Prueba con otra búsqueda.' : 'Crea el primero con su cédula.'}
        </Empty>
      ) : (
        <div class="route-list">
          {list.map((c) => {
            const s = CLIENT_STATE[c.state];
            const blocked = c.blocked_by_admin || myBlocks.has(c.id);
            return (
              <button type="button" class="route-row" onClick={() => setSelected(c)} data-enter>
                <Avatar name={c.full_name} tone="paper" size={44} />
                <div class="route-main">
                  <span class="route-name">{c.full_name}</span>
                  <span class="route-sub">
                    <StatusDot tone={blocked ? 'coral' : s.tone} />
                    <span class="route-state">{blocked ? 'No prestar' : s.label}</span>
                    {c.neighborhood && <span class="route-addr">{c.neighborhood}</span>}
                  </span>
                </div>
                {c.balance > 0 && <div class="route-amount num">{cop(c.balance)}</div>}
                <Icon name="chevron" size={18} class="route-chevron" />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );

  return (
    <>
      <PageHeader title="Clientes" actions={<Button size="sm" icon="plus" onClick={openNew}>Nuevo</Button>} />
      <div class="toolbar" data-enter>
        <Field label="Buscar" class="toolbar-search" value={term} onInput={(e) => setTerm(e.currentTarget.value)} placeholder="Nombre, cédula o barrio" prefix={<Icon name="search" size={18} />} />
        <Pills label="Filtrar clientes" value={filter} onChange={setFilter} options={FILTERS} />
      </div>
      {isAdmin && (
        <div class="only-mobile" data-enter>
          <Pills label="Vista" value={view} onChange={setView} options={[{ value: 'lista', label: 'Lista' }, { value: 'mapa', label: 'Mapa' }]} />
        </div>
      )}
      {isAdmin ? (
        <div class="clients-split">
          <div class={view === 'mapa' ? 'hide-mobile' : ''}>{listView}</div>
          <div class={`clients-map ${view === 'lista' ? 'hide-mobile' : ''}`} data-enter>
            <ClientsMap points={points} onSelect={(p) => setSelected(p.client)} />
            <div class="chart-legend">
              {Object.values(CLIENT_STATE).map((s) => <span><StatusDot tone={s.tone} />{s.label}</span>)}
            </div>
          </div>
        </div>
      ) : (
        listView
      )}

      <ClientDetail
        client={selected}
        blockedByMe={selected ? myBlocks.has(selected.id) : false}
        onClose={() => setSelected(null)}
        onEdit={(c) => {
          setSelected(null);
          clientSheets.set({ form: true, editing: c });
        }}
      />
    </>
  );
}

// Formulario de cliente disponible en todas las pantallas (se abre desde Inicio, Clientes o el menú)
export function ClientFormHost() {
  const sheets = useStore(clientSheets);
  return <ClientForm open={sheets.form} editing={sheets.editing} onClose={() => clientSheets.set({ form: false, editing: null })} />;
}
