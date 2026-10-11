import { useState } from 'preact/hooks';
import { useQuery } from '../../lib/query.js';
import { fmtDate, fmtTime } from '../../lib/dates.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Empty, ErrorState, Pills, Select, Skeleton } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { fetchLogs, fetchOverview } from './data.js';

// Acá se ven los logs: actividad (quién hizo qué) y errores, global o por ruta
const ACTION = { insert: 'Creó', update: 'Modificó', delete: 'Eliminó', create: 'Creó', reset_password: 'Cambió la contraseña de', activate: 'Activó', deactivate: 'Desactivó' };
const ENTITY = {
  organizations: 'la ruta', profiles: 'un usuario', settings: 'la configuración', clients: 'un cliente', loans: 'un préstamo', payments: 'un pago',
  capital_movements: 'un movimiento de capital', expenses: 'un gasto', cash_closures: 'un cuadre', client_assignment_history: 'una reasignación',
  payment_accounts: 'una cuenta', collection_schedules: 'los días de cobro', subscription_payments: 'un pago de suscripción', fixed_costs: 'un costo fijo',
  admin: 'un administrador', cobrador: 'un cobrador', super_admin: 'un súper admin'
};

export function LogList({ kind, query, routeNames }) {
  if (query.loading && !query.data) return <div class="list-card list-flat">{[1, 2, 3].map(() => <div class="row"><div class="row-main"><Skeleton w="70%" /><Skeleton w="40%" h={12} /></div></div>)}</div>;
  if (query.error && !query.data) return <ErrorState error={query.error} onRetry={query.reload} />;
  if (!query.data?.length) return <Empty icon={kind === 'errores' ? 'check' : 'logs'} title={kind === 'errores' ? 'Sin errores' : 'Sin actividad'}>{kind === 'errores' ? 'No se han registrado errores.' : 'Aún no hay acciones registradas.'}</Empty>;
  return (
    <div class="list-card list-flat log-list">
      {query.data.map((l) => {
        const who = (kind === 'errores' ? l.user : l.actor)?.full_name || 'Sistema';
        const where = routeNames?.get(l.organization_id);
        return (
          <div class="row">
            <span class={`row-icon ${kind === 'errores' ? 'tone-bg-coral' : ''}`}><Icon name={kind === 'errores' ? 'alert' : 'logs'} size={17} /></span>
            <div class="row-main">
              {kind === 'errores' ? (
                <>
                  <span class="row-title log-msg">{l.message}</span>
                  <span class="row-sub">{who}{where ? `, ${where}` : ''}, {l.source}{l.url ? `, ${l.url}` : ''}</span>
                </>
              ) : (
                <>
                  <span class="row-title">{who} {(ACTION[l.action] || l.action).toLowerCase()} {ENTITY[l.entity] || l.entity}</span>
                  <span class="row-sub">{where ? `${where}. ` : ''}{l.changed_fields?.length ? `Cambió: ${l.changed_fields.join(', ')}` : ''}</span>
                </>
              )}
            </div>
            <span class="row-meta">{fmtDate(l.created_at)}<br />{fmtTime(l.created_at)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Logs() {
  const [kind, setKind] = useState('errores');
  const [org, setOrg] = useState('');
  const routes = useQuery('sa:overview', fetchOverview, { persist: true });
  const logs = useQuery(`sa:logs:${org || 'all'}:${kind}`, () => fetchLogs({ kind, orgId: org }));
  const names = new Map((routes.data || []).map((r) => [r.organization_id, r.name]));

  return (
    <>
      <PageHeader title="Logs" />
      <div class="toolbar" data-enter>
        <Pills label="Tipo" value={kind} onChange={setKind} options={[{ value: 'errores', label: 'Errores' }, { value: 'actividad', label: 'Actividad' }]} />
        <Select label="Ruta" class="toolbar-select" value={org} onChange={(e) => setOrg(e.currentTarget.value)}>
          <option value="">Todas las rutas</option>
          <option value="none">Plataforma (sin ruta)</option>
          {(routes.data || []).map((r) => <option value={r.organization_id}>{r.name}</option>)}
        </Select>
      </div>
      <section class="settings-card settings-wide" data-enter>
        <LogList kind={kind} query={logs} routeNames={names} />
      </section>
    </>
  );
}
