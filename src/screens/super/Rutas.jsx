import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session } from '../../lib/session.js';
import { manageUsers, message } from '../../lib/api.js';
import { useQuery, invalidate } from '../../lib/query.js';
import { Link } from '../../lib/router.jsx';
import { cop, parseCop } from '../../lib/money.js';
import { addDays, todayISO, timeAgo, fmtDate, greeting } from '../../lib/dates.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Money } from '../../components/Money.jsx';
import { Sheet } from '../../components/Sheet.jsx';
import { Button, Empty, ErrorState, Field, PasswordField, Pills, Skeleton, StatusDot, Switch } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { toast } from '../../components/Toast.jsx';
import { suggestPassword } from '../../lib/password.js';
import { fetchOverview, fetchMonthIncome, accessOf } from './data.js';
import { superSheets } from './sheets.js';

// Acá el súper admin ve todas las rutas, su suscripción y su uso
function NewRouteSheet({ open, onClose }) {
  const empty = () => ({ name: '', code: '', full_name: '', username: '', phone: '', password: suggestPassword(), price: '', exempt: false, discountType: '', discountValue: '', discountReason: '', endsAt: addDays(todayISO(), 30) });
  const [f, setF] = useState(empty());
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  useEffect(() => {
    if (open) {
      setF(empty());
      setCreated(null);
    }
  }, [open]);
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const price = parseCop(f.price);
  const disc = f.discountType === 'fijo' ? parseCop(f.discountValue) : Number(f.discountValue) || 0;
  const monthly = f.exempt ? 0 : Math.max(0, price - (f.discountType === 'porcentaje' ? Math.round((price * disc) / 100) : f.discountType === 'fijo' ? disc : 0));

  const submit = async (e) => {
    e.preventDefault();
    if (!f.name.trim() || !f.code || !f.full_name.trim() || !f.username) return toast('Completa el nombre de la ruta, el código y los datos del administrador.', 'error');
    setBusy(true);
    try {
      await manageUsers('create_admin', {
        full_name: f.full_name.trim(),
        username: f.username,
        phone: f.phone || null,
        password: f.password,
        organization: {
          name: f.name.trim(),
          code: f.code,
          subscription_price: price,
          subscription_exempt: f.exempt,
          discount_type: f.discountType || null,
          discount_value: disc,
          discount_reason: f.discountReason || null,
          subscription_ends_at: f.endsAt
        }
      });
      setCreated({ code: f.code, username: f.username, password: f.password });
      invalidate('sa:');
      toast('Ruta creada');
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={created ? 'Ruta lista' : 'Nueva ruta'} subtitle={created ? null : 'Crea la ruta y su administrador.'} size="lg">
      {created ? (
        <div class="form">
          <div class="cred-card" data-enter>
            <p class="muted">Comparte estos datos con el dueño de la ruta. La contraseña no se volverá a mostrar.</p>
            <dl>
              <div><dt>Código de ruta</dt><dd>{created.code}</dd></div>
              <div><dt>Usuario</dt><dd>{created.username}</dd></div>
              <div><dt>Contraseña</dt><dd class="num">{created.password}</dd></div>
            </dl>
          </div>
          <Button size="lg" class="btn-block" onClick={onClose}>Listo</Button>
        </div>
      ) : (
        <form class="form" onSubmit={submit}>
          <section class="form-section" data-enter>
            <h3>Ruta</h3>
            <div class="form-row">
              <Field label="Nombre" placeholder="Ej. Ruta Norte" value={f.name} onInput={set('name')} />
              <Field label="Código" hint="Con esto inician sesión todos sus usuarios." placeholder="rutanorte" value={f.code} onInput={(e) => setF({ ...f, code: e.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} autocapitalize="none" />
            </div>
          </section>
          <section class="form-section" data-enter>
            <h3>Administrador</h3>
            <div class="form-row">
              <Field label="Nombre completo" value={f.full_name} onInput={set('full_name')} />
              <Field label="Usuario" value={f.username} onInput={(e) => setF({ ...f, username: e.currentTarget.value.toLowerCase().replace(/[^a-z0-9._-]/g, '') })} autocapitalize="none" />
            </div>
            <div class="form-row">
              <Field label="Celular (opcional)" type="tel" value={f.phone} onInput={set('phone')} />
              <PasswordField label="Contraseña inicial" value={f.password} onInput={set('password')} />
            </div>
          </section>
          <section class="form-section" data-enter>
            <h3>Suscripción</h3>
            <Switch label="Acceso especial sin cobro" checked={f.exempt} onChange={(v) => setF({ ...f, exempt: v })} />
            {!f.exempt && (
              <>
                <Field label="Valor mensual" inputMode="numeric" prefix="$" value={price ? price.toLocaleString('es-CO') : ''} onInput={set('price')} />
                <Pills label="Descuento" value={f.discountType} onChange={(v) => setF({ ...f, discountType: v })} options={[{ value: '', label: 'Sin descuento' }, { value: 'porcentaje', label: 'Porcentaje' }, { value: 'fijo', label: 'Valor fijo' }]} />
                {f.discountType && (
                  <div class="form-row">
                    <Field label={f.discountType === 'fijo' ? 'Descuento' : 'Porcentaje'} inputMode="decimal" value={f.discountType === 'fijo' ? (disc ? disc.toLocaleString('es-CO') : '') : f.discountValue} onInput={set('discountValue')} />
                    <Field label="Motivo" placeholder="Ej. referido de Ruta Sur" value={f.discountReason} onInput={set('discountReason')} />
                  </div>
                )}
              </>
            )}
            <Field label="Acceso activo hasta" type="date" value={f.endsAt} onInput={set('endsAt')} />
            <p class="example">Cobro mensual: <b class="num">{cop(monthly)}</b></p>
          </section>
          <Button type="submit" size="lg" loading={busy} class="btn-block">Crear ruta</Button>
        </form>
      )}
    </Sheet>
  );
}

const FILTERS = [
  { value: 'todas', label: 'Todas' },
  { value: 'vencer', label: 'Por vencer' },
  { value: 'vencidas', label: 'Vencidas' },
  { value: 'especial', label: 'Acceso especial' }
];

export function Rutas() {
  const ctx = useStore(session, (s) => s.ctx);
  const open = useStore(superSheets, (s) => s.newRoute);
  const [filter, setFilter] = useState('todas');
  const routes = useQuery('sa:overview', fetchOverview, { persist: true });
  const income = useQuery('sa:income', fetchMonthIncome, { persist: true });
  const list = routes.data || [];

  const stats = useMemo(() => {
    const s = { active: 0, soon: 0, late: 0, clients: 0, mrr: 0 };
    for (const r of list) {
      if (r.access_level === 'full') s.active++;
      if (r.access_level === 'full' && r.days_left != null && r.days_left <= 5) s.soon++;
      if (r.access_level !== 'full') s.late++;
      s.clients += r.active_clients;
      s.mrr += Number(r.monthly_amount || 0);
    }
    return s;
  }, [list]);

  const shown = list.filter((r) =>
    filter === 'vencer' ? r.access_level === 'full' && r.days_left != null && r.days_left <= 5 : filter === 'vencidas' ? r.access_level !== 'full' : filter === 'especial' ? r.subscription_exempt : true
  );

  return (
    <>
      <PageHeader eyebrow={greeting() + ','} title={ctx.full_name.split(' ')[0]} />

      <section class="hero" data-enter>
        <div class="hero-label"><span>Ingresos de suscripción este mes</span></div>
        {income.data != null ? <Money value={income.data} /> : <Skeleton h={56} w="60%" r={16} />}
        <p class="hero-split muted">
          <span><i class="legend-dot" style={{ background: 'var(--lime)' }} />Facturación mensual esperada {cop(stats.mrr)}</span>
        </p>
      </section>

      <div class="kpi-grid" data-enter>
        <article class="kpi"><span class="kpi-icon tone-bg-lime"><Icon name="route" size={18} /></span><p class="kpi-num num">{stats.active}</p><span class="kpi-label">Rutas al día</span></article>
        <article class="kpi"><span class="kpi-icon tone-bg-lav"><Icon name="calendar" size={18} /></span><p class="kpi-num num">{stats.soon}</p><span class="kpi-label">Vencen en 5 días</span></article>
        <article class="kpi"><span class="kpi-icon tone-bg-coral"><Icon name="lock" size={18} /></span><p class="kpi-num num">{stats.late}</p><span class="kpi-label">Vencidas o suspendidas</span></article>
        <article class="kpi"><span class="kpi-icon tone-bg-amber"><Icon name="users" size={18} /></span><p class="kpi-num num">{stats.clients}</p><span class="kpi-label">Clientes activos en total</span></article>
      </div>

      <div class="toolbar" data-enter>
        <Pills label="Filtrar rutas" value={filter} onChange={setFilter} options={FILTERS} />
      </div>

      {routes.loading && !routes.data ? (
        <div class="card-grid">{[1, 2, 3].map(() => <div class="route-card"><Skeleton w="50%" /><Skeleton w="80%" h={12} /><Skeleton h={40} /></div>)}</div>
      ) : routes.error && !routes.data ? (
        <ErrorState error={routes.error} onRetry={routes.reload} />
      ) : !list.length ? (
        <Empty icon="route" title="Crea la primera ruta" action={<Button icon="plus" onClick={() => superSheets.set({ newRoute: true })}>Nueva ruta</Button>}>
          Cada ruta tiene su administrador, sus cobradores y su suscripción.
        </Empty>
      ) : (
        <div class="card-grid">
          {shown.map((r) => {
            const a = accessOf(r);
            return (
              <Link href={`/rutas/${r.organization_id}`} class="route-card" data-enter>
                <div class="route-card-top">
                  <div>
                    <strong>{r.name}</strong>
                    <span class="muted">{r.code}, {r.admin_name || 'sin administrador'}</span>
                  </div>
                  <span class={`tag tag-${a.tone}`}><StatusDot tone={a.tone} />{a.label}</span>
                </div>
                <div class="person-stats">
                  <div><span>Clientes</span><b class="num">{r.active_clients}</b></div>
                  <div><span>Cobradores</span><b class="num">{r.active_collectors}</b></div>
                  <div><span>En mora</span><b class="num">{r.overdue_loans}</b></div>
                </div>
                <div class="route-card-foot">
                  <span>{r.subscription_ends_at ? `Hasta el ${fmtDate(r.subscription_ends_at, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Sin vencimiento'}</span>
                  <span>Último uso: {timeAgo(r.last_seen).toLowerCase()}</span>
                  {r.errors_7d > 0 && <span class="text-coral">{r.errors_7d} error{r.errors_7d === 1 ? '' : 'es'} esta semana</span>}
                </div>
              </Link>
            );
          })}
          {!shown.length && <p class="muted">Ninguna ruta en este filtro.</p>}
        </div>
      )}

      <NewRouteSheet open={open} onClose={() => superSheets.set({ newRoute: false })} />
    </>
  );
}
