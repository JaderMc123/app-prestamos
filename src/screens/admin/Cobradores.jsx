import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session, canWrite } from '../../lib/session.js';
import { supabase } from '../../lib/supabase.js';
import { q, rpc, manageUsers, message } from '../../lib/api.js';
import { useQuery, invalidate } from '../../lib/query.js';
import { cop, parseCop } from '../../lib/money.js';
import { WEEKDAYS, timeAgo } from '../../lib/dates.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Sheet } from '../../components/Sheet.jsx';
import { Avatar, Button, Empty, ErrorState, Field, PasswordField, Skeleton, Switch } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { toast } from '../../components/Toast.jsx';
import { suggestPassword } from '../../lib/password.js';
import { adminSheets } from './sheets.js';
import { navigate } from '../../lib/router.jsx';

// Acá el administrador crea cobradores, les cambia la contraseña, los activa/desactiva y les asigna capital
export const fetchCollectors = () =>
  q(
    supabase
      .from('profiles')
      .select('id,full_name,username,phone,is_active,can_view_total_capital,last_seen_at,collection_schedules(weekdays)')
      .eq('role', 'cobrador')
      .order('full_name')
  );

function Weekdays({ value, onChange }) {
  const toggle = (n) => onChange(value.includes(n) ? value.filter((d) => d !== n) : [...value, n].sort());
  return (
    <div class="field">
      <span class="field-label">Días de cobro</span>
      <div class="weekdays" role="group" aria-label="Días de cobro">
        {WEEKDAYS.map((d) => (
          <button type="button" class={`weekday ${value.includes(d.n) ? 'is-on' : ''}`} aria-pressed={value.includes(d.n)} aria-label={d.name} onClick={() => toggle(d.n)}>
            {d.short}
          </button>
        ))}
      </div>
    </div>
  );
}

function CredentialsCard({ code, username, password }) {
  const text = `Código de ruta: ${code}\nUsuario: ${username}\nContraseña: ${password}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Datos copiados');
    } catch {
      toast('No se pudo copiar', 'error');
    }
  };
  return (
    <div class="cred-card" data-enter>
      <p class="muted">Comparte estos datos con el cobrador. La contraseña no se volverá a mostrar.</p>
      <dl>
        <div><dt>Código de ruta</dt><dd>{code}</dd></div>
        <div><dt>Usuario</dt><dd>{username}</dd></div>
        <div><dt>Contraseña</dt><dd class="num">{password}</dd></div>
      </dl>
      <Button variant="ghost" size="sm" icon="check" onClick={copy}>Copiar datos</Button>
    </div>
  );
}

function NewCollectorSheet({ open, onClose }) {
  const ctx = useStore(session, (s) => s.ctx);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState(suggestPassword());
  const [days, setDays] = useState([1, 2, 3, 4, 5, 6]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  useEffect(() => {
    if (open) {
      setName('');
      setUsername('');
      setPhone('');
      setPassword(suggestPassword());
      setDays([1, 2, 3, 4, 5, 6]);
      setCreated(null);
    }
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    if (!canWrite()) return toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
    if (!name.trim() || !username.trim()) return toast('Escribe el nombre y el usuario.', 'error');
    if (!days.length) return toast('Elige al menos un día de cobro.', 'error');
    setBusy(true);
    try {
      const { user_id } = await manageUsers('create_collector', { full_name: name.trim(), username, phone: phone || null, password });
      await q(supabase.from('collection_schedules').update({ weekdays: days }).eq('collector_id', user_id));
      setCreated({ username, password });
      invalidate('admin:');
      toast('Cobrador creado');
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={created ? 'Cobrador listo' : 'Nuevo cobrador'} subtitle={created ? null : 'Podrá entrar con el código de tu ruta.'}>
      {created ? (
        <div class="form">
          <CredentialsCard code={ctx.organization.code} username={created.username} password={created.password} />
          <Button size="lg" class="btn-block" onClick={onClose}>Listo</Button>
        </div>
      ) : (
        <form class="form" onSubmit={submit}>
          <div data-enter><Field label="Nombre completo" value={name} onInput={(e) => setName(e.currentTarget.value)} autocomplete="off" /></div>
          <div data-enter>
            <Field label="Usuario" hint="Sin espacios. Con esto inicia sesión." value={username} onInput={(e) => setUsername(e.currentTarget.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))} autocapitalize="none" prefix={<Icon name="user" size={18} />} />
          </div>
          <div data-enter><Field label="Celular (opcional)" type="tel" inputMode="tel" value={phone} onInput={(e) => setPhone(e.currentTarget.value)} prefix={<Icon name="phone" size={18} />} /></div>
          <div data-enter>
            <PasswordField label="Contraseña inicial" value={password} onInput={(e) => setPassword(e.currentTarget.value)} hint="El cobrador podrá cambiarla después." />
          </div>
          <div data-enter><Weekdays value={days} onChange={setDays} /></div>
          <Button type="submit" size="lg" loading={busy} class="btn-block">Crear cobrador</Button>
        </form>
      )}
    </Sheet>
  );
}

export function CollectorManage({ collector, part = 'all' }) {
  const caja = part !== 'config';
  const config = part !== 'caja';
  const [days, setDays] = useState(collector?.collection_schedules?.weekdays || [1, 2, 3, 4, 5, 6]);
  const [seeAll, setSeeAll] = useState(!!collector?.can_view_total_capital);
  const [active, setActive] = useState(!!collector?.is_active);
  const [capital, setCapital] = useState('');
  const [newPass, setNewPass] = useState('');
  const [busy, setBusy] = useState('');
  const [counted, setCounted] = useState('');
  const [handed, setHanded] = useState('');
  const [adjust, setAdjust] = useState(true);
  const overview = useQuery(collector ? 'admin:overview' : null, () => rpc('admin_overview'), { persist: true });
  const summary = useQuery(collector ? 'admin:summary' : null, () => rpc('get_capital_summary'), { persist: true });
  const live = (overview.data?.collectors || []).find((c) => c.id === collector?.id);
  const expected = Number(live?.cash ?? 0);
  const myCash = Number(summary.data?.tesoreria ?? 0);

  useEffect(() => {
    if (!collector) return;
    setDays(collector.collection_schedules?.weekdays || [1, 2, 3, 4, 5, 6]);
    setSeeAll(!!collector.can_view_total_capital);
    setActive(!!collector.is_active);
    setCapital('');
    setNewPass('');
    setCounted('');
    setHanded('');
    setAdjust(true);
  }, [collector?.id]);

  const guard = () => {
    if (canWrite()) return true;
    toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
    return false;
  };

  const run = async (key, fn, ok) => {
    if (!guard()) return false;
    setBusy(key);
    try {
      await fn();
      toast(ok);
      invalidate('admin:');
      return true;
    } catch (err) {
      toast(message(err), 'error');
      return false;
    } finally {
      setBusy('');
    }
  };

  if (!collector) return null;
  const amount = parseCop(capital);
  // Cuadre: lo que el cobrador cuenta y lo que te entrega (eso entra a tu caja)
  const countedV = counted === '' ? expected : parseCop(counted);
  const handedV = handed === '' ? countedV : parseCop(handed);
  const diff = countedV - expected;

  const closeCash = () =>
    run(
      'cuadre',
      () => rpc('close_cash', { p_collector_id: collector.id, p_cash_reported: countedV, p_cash_handed_over: handedV, p_apply_adjustment: diff !== 0 && adjust }),
      handedV > 0 ? `Cuadre cerrado. Recibiste ${cop(handedV)} en tu caja` : 'Cuadre cerrado'
    ).then((done) => {
      if (done) {
        setCounted('');
        setHanded('');
      }
    });

  return (
    <div class="form collector-manage">
      {caja && (
        <>
        <section class="form-section" data-enter>
          <h3>Asignar capital</h3>
          <p class="muted">Sale de tu caja ({cop(myCash)}) y pasa a la caja de este cobrador.</p>
          <div class="inline-form">
            <Field label="Monto" inputMode="numeric" value={amount ? amount.toLocaleString('es-CO') : ''} onInput={(e) => setCapital(e.currentTarget.value)} prefix="$" />
            <Button
              loading={busy === 'capital'}
              disabled={!amount}
              onClick={() =>
                run('capital', () => rpc('transfer_capital', { p_amount: amount, p_to_collector: collector.id, p_note: 'Asignación de capital' }), `Asignaste ${cop(amount)}`).then((done) => done && setCapital(''))
              }
            >
              Asignar
            </Button>
          </div>
        </section>

        <section class="form-section" data-enter>
          <h3>Cuadre de caja</h3>
          <div class="cuadre-box">
            <div><span>Debe tener en efectivo</span><b class="num">{cop(expected)}</b></div>
            <div><span>Cobró hoy</span><b class="num">{cop(live?.collected_today || 0)}</b></div>
          </div>
          <div class="form-row">
            <Field label="Efectivo que contó" inputMode="numeric" prefix="$" value={counted === '' ? '' : countedV.toLocaleString('es-CO')} placeholder={expected.toLocaleString('es-CO')} onInput={(e) => setCounted(e.currentTarget.value)} />
            <Field label="Te entrega a ti" inputMode="numeric" prefix="$" value={handed === '' ? '' : handedV.toLocaleString('es-CO')} placeholder={countedV.toLocaleString('es-CO')} onInput={(e) => setHanded(e.currentTarget.value)} hint="Este dinero entra a tu caja. Si lo dejas vacío, entrega todo." />
          </div>
          {diff !== 0 && (
            <Switch
              label={diff < 0 ? `Faltan ${cop(-diff)}` : `Sobran ${cop(diff)}`}
              hint="Registrar la diferencia para que la caja del cobrador quede igual a lo que contó."
              checked={adjust}
              onChange={setAdjust}
            />
          )}
          {handedV > countedV && <p class="field-error">No puede entregarte más de lo que contó.</p>}
          <p class="example">
            Tu caja queda en <b class="num">{cop(myCash + handedV)}</b> y el cobrador se queda con <b class="num">{cop(Math.max(0, (diff !== 0 && adjust ? countedV : expected) - handedV))}</b>.
          </p>
          <Button loading={busy === 'cuadre'} disabled={handedV > countedV || countedV < 0} onClick={closeCash} icon="check">Cerrar cuadre</Button>
        </section>
        </>
      )}

      {config && (
        <>

        <section class="form-section" data-enter>
          <h3>Días laborales</h3>
          <Weekdays value={days} onChange={setDays} />
          <Button variant="ghost" size="sm" loading={busy === 'days'} disabled={!days.length} onClick={() => run('days', () => q(supabase.from('collection_schedules').update({ weekdays: days }).eq('collector_id', collector.id)), 'Días de cobro guardados')}>
            Guardar días
          </Button>
        </section>

        <section class="form-section" data-enter>
          <Switch
            label="Ver el capital total de la ruta"
            hint="Si está apagado, solo ve lo que tiene asignado."
            checked={seeAll}
            onChange={(v) => {
              setSeeAll(v);
              run('see', () => q(supabase.from('profiles').update({ can_view_total_capital: v }).eq('id', collector.id)), v ? 'Ahora ve el capital total' : 'Ahora solo ve lo asignado');
            }}
          />
          <Switch
            label="Usuario activo"
            hint="Al desactivarlo se cierra su sesión en el celular."
            checked={active}
            onChange={(v) => {
              setActive(v);
              run('active', () => manageUsers('set_active', { user_id: collector.id, active: v }), v ? 'Cobrador activado' : 'Cobrador desactivado');
            }}
          />
        </section>

        <section class="form-section" data-enter>
          <h3>Restablecer contraseña</h3>
          <div class="inline-form">
            <PasswordField label="Nueva contraseña" value={newPass} onInput={(e) => setNewPass(e.currentTarget.value)} />
            <Button
              variant="ghost"
              loading={busy === 'pass'}
              disabled={newPass.length < 8}
              onClick={() => run('pass', () => manageUsers('reset_password', { user_id: collector.id, password: newPass }), 'Contraseña cambiada').then((done) => done && setNewPass(''))}
            >
              Cambiar
            </Button>
          </div>
          <button type="button" class="link-btn" onClick={() => setNewPass(suggestPassword())}>Sugerir una contraseña</button>
        </section>
        </>
      )}
    </div>
  );
}

export function Cobradores() {
  const newOpen = useStore(adminSheets, (s) => s.newCollector);
  const setNewOpen = (v) => adminSheets.set({ newCollector: v });
  const list = useQuery('admin:collectors', fetchCollectors, { persist: true });
  const overview = useQuery('admin:overview', () => rpc('admin_overview'), { persist: true });
  const stats = new Map((overview.data?.collectors || []).map((c) => [c.id, c]));

  return (
    <>
      <PageHeader title="Cobradores" actions={<Button size="sm" icon="plus" class="only-mobile" onClick={() => setNewOpen(true)}>Nuevo</Button>} />
      {list.loading && !list.data ? (
        <div class="card-grid">{[1, 2, 3].map(() => <div class="person-card"><Skeleton h={48} w={48} r={24} /><Skeleton w="60%" /><Skeleton w="40%" h={12} /></div>)}</div>
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : !list.data.length ? (
        <Empty icon="users" title="Crea tu primer cobrador" action={<Button icon="plus" onClick={() => setNewOpen(true)}>Nuevo cobrador</Button>}>
          Le das un usuario y contraseña, y entra con el código de tu ruta.
        </Empty>
      ) : (
        <div class="card-grid">
          {list.data.map((c) => {
            const st = stats.get(c.id);
            return (
              <button type="button" class={`person-card ${c.is_active ? '' : 'is-off'}`} onClick={() => navigate(`/cobradores/${c.id}`)} data-enter>
                <div class="person-top">
                  <Avatar name={c.full_name} tone={c.is_active ? 'lime' : 'dark'} size={48} />
                  <span class={`tag ${c.is_active ? 'tag-ok' : 'tag-off'}`}>{c.is_active ? 'Activo' : 'Inactivo'}</span>
                </div>
                <strong>{c.full_name}</strong>
                <span class="muted">{c.username}, {timeAgo(c.last_seen_at).toLowerCase()}</span>
                <div class="person-stats">
                  <div><span>Caja</span><b class="num">{cop(st?.cash || 0)}</b></div>
                  <div><span>Hoy</span><b class="num">{cop(st?.collected_today || 0)}</b></div>
                  <div><span>Préstamos</span><b class="num">{st?.active_loans ?? 0}</b></div>
                </div>
              </button>
            );
          })}
        </div>
      )}
      <NewCollectorSheet open={newOpen} onClose={() => setNewOpen(false)} />
    </>
  );
}
