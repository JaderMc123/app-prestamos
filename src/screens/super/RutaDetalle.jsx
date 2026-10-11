import { useEffect, useState } from 'preact/hooks';
import { supabase } from '../../lib/supabase.js';
import { q, rpc, manageUsers, message } from '../../lib/api.js';
import { useQuery, invalidate } from '../../lib/query.js';
import { cop, parseCop } from '../../lib/money.js';
import { fmtDate, timeAgo } from '../../lib/dates.js';
import { suggestPassword } from '../../lib/password.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Sheet } from '../../components/Sheet.jsx';
import { Avatar, Button, ErrorState, Field, PasswordField, Pills, Select, Skeleton, Switch } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { toast } from '../../components/Toast.jsx';
import { fetchOrg, fetchOrgUsers, fetchOrgPayments, fetchLogs } from './data.js';
import { LogList } from './Logs.jsx';

// Acá el súper admin administra una ruta: suscripción, pagos, usuarios y logs
const ROLE = { admin: 'Administrador', cobrador: 'Cobrador' };

function PaymentSheet({ org, open, onClose, onDone }) {
  const [months, setMonths] = useState('1');
  const [method, setMethod] = useState('nequi');
  const [reference, setReference] = useState('');
  const [override, setOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const base = org.subscription_exempt ? 0 : Math.max(0, org.subscription_price - (org.discount_type === 'porcentaje' ? Math.round((org.subscription_price * org.discount_value) / 100) : org.discount_type === 'fijo' ? Number(org.discount_value) : 0));
  const total = override ? parseCop(override) : base * Number(months);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await rpc('sa_register_subscription_payment', { p_org: org.id, p_months: Number(months), p_method: method, p_reference: reference || null, p_amount_override: override ? parseCop(override) : null });
      toast('Pago registrado. La ruta quedó activa.');
      onDone();
      onClose();
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Registrar pago" subtitle={`${org.name}, ${cop(base)} al mes`}>
      <form class="form" onSubmit={submit}>
        <div data-enter><Pills label="Meses" value={months} onChange={setMonths} options={['1', '2', '3', '6', '12'].map((m) => ({ value: m, label: m === '1' ? '1 mes' : `${m} meses` }))} /></div>
        <div data-enter>
          <Select label="Método" value={method} onChange={(e) => setMethod(e.currentTarget.value)}>
            <option value="nequi">Nequi</option>
            <option value="bancolombia">Bancolombia</option>
            <option value="efectivo">Efectivo</option>
            <option value="otro">Otro</option>
          </Select>
        </div>
        <div data-enter><Field label="Referencia (opcional)" value={reference} onInput={(e) => setReference(e.currentTarget.value)} /></div>
        <div data-enter><Field label="Cobrar otro valor (opcional)" inputMode="numeric" prefix="$" value={override ? parseCop(override).toLocaleString('es-CO') : ''} onInput={(e) => setOverride(e.currentTarget.value)} hint="Déjalo vacío para usar el valor calculado." /></div>
        <p class="example" data-enter>Total: <b class="num">{cop(total)}</b></p>
        <Button type="submit" size="lg" loading={busy} class="btn-block">Registrar pago</Button>
      </form>
    </Sheet>
  );
}

function SubscriptionCard({ org, onSaved }) {
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF({ price: String(org.subscription_price), exempt: org.subscription_exempt, dType: org.discount_type || '', dValue: String(org.discount_value || ''), dReason: org.discount_reason || '', ends: org.subscription_ends_at || '', grace: org.grace_days_override ?? '', suspended: org.suspended, reason: org.suspended_reason || '' }), [org.updated_at]);
  if (!f) return null;
  const set = (k, v) => setF({ ...f, [k]: v });

  const save = async () => {
    setBusy(true);
    try {
      await q(
        supabase
          .from('organizations')
          .update({
            subscription_price: parseCop(f.price),
            subscription_exempt: f.exempt,
            discount_type: f.dType || null,
            discount_value: f.dType === 'fijo' ? parseCop(f.dValue) : Number(String(f.dValue).replace(',', '.')) || 0,
            discount_reason: f.dReason || null,
            subscription_ends_at: f.ends || null,
            grace_days_override: f.grace === '' ? null : Number(f.grace),
            suspended: f.suspended,
            suspended_reason: f.suspended ? f.reason || null : null
          })
          .eq('id', org.id)
      );
      toast('Suscripción actualizada');
      onSaved();
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="settings-card" data-enter>
      <header>
        <span class="row-icon tone-bg-lime"><Icon name="calendar" size={19} /></span>
        <div><h2>Suscripción</h2><p class="muted">Valor, descuentos, vencimiento y acceso.</p></div>
      </header>
      <Switch label="Acceso especial sin cobro" checked={f.exempt} onChange={(v) => set('exempt', v)} />
      {!f.exempt && (
        <>
          <Field label="Valor mensual" inputMode="numeric" prefix="$" value={parseCop(f.price) ? parseCop(f.price).toLocaleString('es-CO') : ''} onInput={(e) => set('price', e.currentTarget.value)} />
          <Pills label="Descuento" value={f.dType} onChange={(v) => set('dType', v)} options={[{ value: '', label: 'Sin descuento' }, { value: 'porcentaje', label: 'Porcentaje' }, { value: 'fijo', label: 'Valor fijo' }]} />
          {f.dType && (
            <div class="form-row">
              <Field label={f.dType === 'fijo' ? 'Descuento' : 'Porcentaje'} inputMode="decimal" value={f.dValue} onInput={(e) => set('dValue', e.currentTarget.value)} />
              <Field label="Motivo" value={f.dReason} onInput={(e) => set('dReason', e.currentTarget.value)} />
            </div>
          )}
        </>
      )}
      <div class="form-row">
        <Field label="Activa hasta" type="date" value={f.ends} onInput={(e) => set('ends', e.currentTarget.value)} />
        <Field label="Días de gracia (vacío = general)" type="number" min="0" value={f.grace} onInput={(e) => set('grace', e.currentTarget.value)} />
      </div>
      <Switch label="Suspender acceso" hint="Bloquea la entrada de todos sus usuarios de inmediato." checked={f.suspended} onChange={(v) => set('suspended', v)} />
      {f.suspended && <Field label="Motivo de la suspensión" value={f.reason} onInput={(e) => set('reason', e.currentTarget.value)} />}
      <Button loading={busy} onClick={save}>Guardar suscripción</Button>
    </section>
  );
}

function UserRow({ u, onChanged }) {
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState('');
  const act = async (key, fn, ok) => {
    setBusy(key);
    try {
      await fn();
      toast(ok);
      onChanged();
      return true;
    } catch (err) {
      toast(message(err), 'error');
      return false;
    } finally {
      setBusy('');
    }
  };
  return (
    <>
      <button type="button" class={`row row-button ${u.is_active ? '' : 'is-off'}`} onClick={() => setOpen(true)}>
        <Avatar name={u.full_name} size={40} tone={u.role === 'admin' ? 'lime' : 'dark'} />
        <div class="row-main">
          <span class="row-title">{u.full_name}</span>
          <span class="row-sub">{ROLE[u.role]}, {u.username}, {timeAgo(u.last_seen_at).toLowerCase()}</span>
        </div>
        <Icon name="chevron" size={18} class="row-chevron" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={u.full_name} subtitle={`${ROLE[u.role]}, usuario ${u.username}`}>
        <div class="form">
          <section class="form-section" data-enter>
            <h3>Restablecer contraseña</h3>
            <div class="inline-form">
              <PasswordField label="Nueva contraseña" value={pass} onInput={(e) => setPass(e.currentTarget.value)} />
              <Button variant="ghost" disabled={pass.length < 8} loading={busy === 'pass'} onClick={() => act('pass', () => manageUsers('reset_password', { user_id: u.id, password: pass }), 'Contraseña cambiada').then((d) => d && setPass(''))}>Cambiar</Button>
            </div>
            <button type="button" class="link-btn" onClick={() => setPass(suggestPassword())}>Sugerir una contraseña</button>
          </section>
          <section class="form-section" data-enter>
            <Switch label="Usuario activo" hint="Al desactivarlo se cierra su sesión." checked={u.is_active} onChange={(v) => act('active', () => manageUsers('set_active', { user_id: u.id, active: v }), v ? 'Usuario activado' : 'Usuario desactivado')} />
          </section>
        </div>
      </Sheet>
    </>
  );
}

export function RutaDetalle({ params }) {
  const id = params.id;
  const org = useQuery(`sa:org:${id}`, () => fetchOrg(id));
  const users = useQuery(`sa:users:${id}`, () => fetchOrgUsers(id));
  const payments = useQuery(`sa:payments:${id}`, () => fetchOrgPayments(id));
  const [tab, setTab] = useState('actividad');
  const logs = useQuery(`sa:logs:${id}:${tab}`, () => fetchLogs({ kind: tab, orgId: id, limit: 40 }));
  const [payOpen, setPayOpen] = useState(false);
  const refresh = () => {
    org.reload();
    users.reload();
    payments.reload();
    invalidate('sa:overview');
  };

  if (org.error && !org.data) return <ErrorState error={org.error} onRetry={org.reload} />;
  const o = org.data;

  return (
    <>
      <PageHeader back="/" eyebrow={o?.code} title={o?.name || 'Ruta'} actions={o && <Button size="sm" icon="wallet" onClick={() => setPayOpen(true)}>Registrar pago</Button>} />
      {!o ? (
        <Skeleton h={300} r={26} />
      ) : (
        <div class="settings-grid">
          <SubscriptionCard org={o} onSaved={refresh} />

          <section class="settings-card" data-enter>
            <header>
              <span class="row-icon tone-bg-lav"><Icon name="users" size={19} /></span>
              <div><h2>Usuarios</h2><p class="muted">Restablece contraseñas o desactiva usuarios.</p></div>
            </header>
            <div class="list-card list-flat">
              {(users.data || []).map((u) => <UserRow u={u} onChanged={users.reload} />)}
            </div>
          </section>

          <section class="settings-card" data-enter>
            <header>
              <span class="row-icon tone-bg-lime"><Icon name="cash" size={19} /></span>
              <div><h2>Pagos de suscripción</h2></div>
            </header>
            <div class="list-card list-flat">
              {(payments.data || []).map((p) => (
                <div class="row">
                  <div class="row-main">
                    <span class="row-title num">{cop(p.amount_charged)}{p.discount_amount > 0 && <span class="muted"> (descuento {cop(p.discount_amount)})</span>}</span>
                    <span class="row-sub">{fmtDate(p.period_start)} al {fmtDate(p.period_end, { day: 'numeric', month: 'short', year: 'numeric' })}, {p.method}</span>
                  </div>
                  <span class="row-meta">{fmtDate(p.paid_at)}</span>
                </div>
              ))}
              {!payments.data?.length && <p class="muted">Aún no hay pagos registrados.</p>}
            </div>
          </section>

          <section class="settings-card settings-wide" data-enter>
            <header>
              <span class="row-icon"><Icon name="logs" size={19} /></span>
              <div><h2>Registro de la ruta</h2></div>
            </header>
            <Pills label="Tipo de registro" value={tab} onChange={setTab} options={[{ value: 'actividad', label: 'Actividad' }, { value: 'errores', label: 'Errores' }]} />
            <LogList kind={tab} query={logs} />
          </section>
        </div>
      )}
      {o && <PaymentSheet org={o} open={payOpen} onClose={() => setPayOpen(false)} onDone={refresh} />}
    </>
  );
}
