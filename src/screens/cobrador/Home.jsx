import { useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session } from '../../lib/session.js';
import { rpc } from '../../lib/api.js';
import { useQuery } from '../../lib/query.js';
import { Link } from '../../lib/router.jsx';
import { greeting } from '../../lib/dates.js';
import { cop } from '../../lib/money.js';
import { dismissFailed, outbox } from '../../lib/outbox.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Money } from '../../components/Money.jsx';
import { ActionPill, Empty, ErrorState, Skeleton } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { RouteRow, RouteSkeleton } from './RouteList.jsx';
import { openCobrar, openGasto } from './sheets.js';
import { openNewClient } from '../shared/clients/sheets.js';

// Pantalla de inicio del cobrador: caja, avance del día y ruta de hoy
export function Home({ route }) {
  const ctx = useStore(session, (s) => s.ctx);
  const userId = useStore(session, (s) => s.user?.id);
  const failed = useStore(outbox, (s) => s.failed);
  const [hidden, setHidden] = useState(false);
  const summary = useQuery(`summary:${userId}`, () => rpc('get_capital_summary'), { persist: true });
  const r = route.data;
  const progress = r && r.goal > 0 ? Math.min(1, r.collectedToday / r.goal) : 0;
  const todo = r?.items.filter((i) => i.state !== 'pagado' && i.state !== 'libre') || [];

  return (
    <div class="home-grid">
      <div class="home-main">
        <PageHeader eyebrow={greeting() + ','} title={ctx.full_name.split(' ')[0]} />

        <section class="hero" data-enter>
          <div class="hero-label">
            <span>Caja disponible</span>
            <button type="button" class="eye-btn" aria-label={hidden ? 'Mostrar montos' : 'Ocultar montos'} onClick={() => setHidden(!hidden)}>
              <Icon name={hidden ? 'eyeOff' : 'eye'} size={17} />
            </button>
          </div>
          {summary.data ? <Money value={summary.data.mi_efectivo} hidden={hidden} /> : <Skeleton h={56} w="70%" r={16} />}
          <div class="hero-actions">
            <ActionPill icon="scan" onClick={() => openCobrar()}>Cobrar</ActionPill>
            <ActionPill icon="plus" onClick={openNewClient}>Prestar</ActionPill>
            <ActionPill icon="cash" onClick={openGasto}>Gasto</ActionPill>
          </div>
          <Link href="/gastos" class="hero-link"><Icon name="cash" size={16} /> Ver mis gastos</Link>
        </section>

        {failed.length > 0 && (
          <div class="banner banner-coral" role="alert" data-enter>
            <Icon name="alert" size={18} />
            <span>
              {failed.length} registro{failed.length === 1 ? '' : 's'} hecho{failed.length === 1 ? '' : 's'} sin señal no se pudo guardar: {failed[0].error}.
              {failed[0].args?.p_amount ? ` Valor: ${cop(failed[0].args.p_amount)}.` : ''} Avísale a tu administrador.
            </span>
            <button type="button" class="link-btn" onClick={dismissFailed}>Entendido</button>
          </div>
        )}

        <div class="cards-scroll" data-enter>
          <article class="stat-card card-lime">
            <div class="stat-top">
              <span>Cobrado hoy</span>
              <span class="stat-chip num">{Math.round(progress * 100)}%</span>
            </div>
            <Money value={r?.collectedToday || 0} size="lg" hidden={hidden} />
            <div class="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin="0" aria-valuemax="100" aria-label="Avance del día">
              <span style={{ transform: `scaleX(${progress})` }} />
            </div>
            <span class="stat-foot">Meta del día {hidden ? '$•••' : cop(r?.goal || 0)}</span>
          </article>
          <article class="stat-card card-lav">
            <div class="stat-top"><span>Capital en la calle</span></div>
            <Money value={summary.data?.mi_capital_en_calle || 0} size="lg" hidden={hidden} />
            <span class="stat-foot">{r ? `${r.items.length} préstamo${r.items.length === 1 ? '' : 's'} activo${r.items.length === 1 ? '' : 's'}` : ' '}</span>
          </article>
          {r?.pendingTransfers > 0 && (
            <article class="stat-card card-dark">
              <div class="stat-top"><span>Transferencias</span></div>
              <p class="stat-big num">{r.pendingTransfers}</p>
              <span class="stat-foot">Esperando que el admin las verifique</span>
            </article>
          )}
        </div>
      </div>

      <section class="paper-panel" data-enter aria-labelledby="ruta-hoy">
        <span class="paper-grab only-mobile" aria-hidden="true" />
        <div class="paper-head">
          <h2 id="ruta-hoy">Ruta de hoy</h2>
          <Link href="/ruta" class="paper-link">Ver todo</Link>
        </div>
        {route.loading && !r ? (
          <RouteSkeleton />
        ) : route.error && !r ? (
          <ErrorState error={route.error} onRetry={route.reload} />
        ) : !todo.length ? (
          <Empty icon="check" title="Ruta al día">No tienes cobros pendientes por hoy.</Empty>
        ) : (
          <div class="route-list">
            {todo.slice(0, 6).map((i) => (
              <RouteRow item={i} onClick={openCobrar} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
