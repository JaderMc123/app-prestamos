import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session, logout, toEmail, SYSTEM_CODE } from '../../lib/session.js';
import { supabase } from '../../lib/supabase.js';
import { PageHeader } from '../../components/Shell.jsx';
import { Avatar, Button, PasswordField } from '../../components/ui.jsx';
import { Sheet } from '../../components/Sheet.jsx';
import { Icon } from '../../components/Icon.jsx';
import { toast } from '../../components/Toast.jsx';
import { fmtDate } from '../../lib/dates.js';
import { pushStatus, enablePush, disablePush, isIOS } from '../../lib/push.js';
import { message } from '../../lib/api.js';

// Acá se activan las notificaciones en el teléfono (las mismas alertas de la campana)
function PushRow() {
  const [status, setStatus] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    pushStatus().then(setStatus).catch(() => setStatus('unsupported'));
  }, []);

  const toggle = async () => {
    if (status === 'needs-install' || status === 'denied' || status === 'unsupported') return setHelp(!help);
    setBusy(true);
    try {
      if (status === 'on') {
        await disablePush();
        toast('Notificaciones del teléfono desactivadas');
      } else {
        await enablePush();
        toast('Listo, te llegarán las alertas al teléfono');
      }
      setStatus(await pushStatus());
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const sub = {
    loading: 'Revisando…',
    on: 'Activadas en este teléfono',
    off: 'Recibe las alertas aunque la app esté cerrada',
    denied: 'Bloqueadas en el teléfono. Toca para ver cómo activarlas',
    'needs-install': 'Primero agrega la app a la pantalla de inicio',
    unsupported: 'Este navegador no permite notificaciones'
  }[status];

  return (
    <>
      <button type="button" class="row row-button" onClick={toggle} disabled={busy || status === 'loading'}>
        <span class={`row-icon ${status === 'on' ? 'tone-bg-lime' : ''}`}><Icon name="bell" size={19} /></span>
        <div class="row-main"><span class="row-title">Notificaciones en el teléfono</span><span class="row-sub">{busy ? 'Un momento…' : sub}</span></div>
        {status === 'on' || status === 'off' ? (
          <span class={`tag ${status === 'on' ? 'tag-lime' : ''}`}>{status === 'on' ? 'Activas' : 'Activar'}</span>
        ) : (
          <Icon name="chevron" size={18} class="row-chevron" />
        )}
      </button>
      {help && (
        <div class="row row-help">
          <p class="muted">
            {status === 'needs-install'
              ? 'En el iPhone abre esta página en Safari, toca Compartir y luego "Agregar a inicio". Abre la app desde el ícono y vuelve aquí para activar las notificaciones.'
              : status === 'denied'
                ? isIOS()
                  ? 'Ve a Ajustes del iPhone, Notificaciones, Cobros y activa "Permitir notificaciones".'
                  : 'Toca el candado junto a la dirección (o mantén presionado el ícono de la app, Información) y permite las notificaciones.'
                : 'Usa Chrome en Android o Safari en iPhone (iOS 16.4 o más nuevo) con la app agregada a la pantalla de inicio.'}
          </p>
        </div>
      )}
    </>
  );
}

const ROLE_LABEL = { super_admin: 'Súper admin', admin: 'Administrador', cobrador: 'Cobrador' };

// Formulario para que el usuario cambie su propia contraseña
export function ChangePasswordSheet({ open, onClose }) {
  const ctx = useStore(session, (s) => s.ctx);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (next.length < 8) return setError('La nueva contraseña debe tener al menos 8 caracteres.');
    if (next !== confirm) return setError('Las contraseñas nuevas no coinciden.');
    setBusy(true);
    try {
      // Se confirma la contraseña actual antes de cambiarla
      const code = ctx.organization?.code || SYSTEM_CODE;
      const { error: e1 } = await supabase.auth.signInWithPassword({ email: toEmail(code, ctx.username), password: current });
      if (e1) throw new Error('La contraseña actual no es correcta.');
      const { error: e2 } = await supabase.auth.updateUser({ password: next });
      if (e2) throw new Error('No se pudo cambiar la contraseña.');
      toast('Contraseña cambiada');
      setCurrent('');
      setNext('');
      setConfirm('');
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Cambiar contraseña" subtitle="Usa al menos 8 caracteres.">
      <form class="form" onSubmit={submit}>
        <div data-enter><PasswordField label="Contraseña actual" value={current} onInput={(e) => setCurrent(e.currentTarget.value)} autocomplete="current-password" /></div>
        <div data-enter><PasswordField label="Nueva contraseña" value={next} onInput={(e) => setNext(e.currentTarget.value)} autocomplete="new-password" /></div>
        <div data-enter><PasswordField label="Repite la nueva contraseña" value={confirm} onInput={(e) => setConfirm(e.currentTarget.value)} autocomplete="new-password" /></div>
        {error && <p class="form-error" role="alert"><Icon name="alert" size={17} />{error}</p>}
        <Button type="submit" size="lg" loading={busy} class="btn-block">Cambiar contraseña</Button>
      </form>
    </Sheet>
  );
}

export function Profile() {
  const ctx = useStore(session, (s) => s.ctx);
  const [pwOpen, setPwOpen] = useState(false);

  return (
    <>
      <PageHeader title="Perfil" />
      <section class="profile-card" data-enter>
        <Avatar name={ctx.full_name} tone="lime" size={64} />
        <div>
          <h2>{ctx.full_name}</h2>
          <p class="muted">{ROLE_LABEL[ctx.role]}{ctx.organization ? `, ${ctx.organization.name}` : ''}</p>
        </div>
      </section>

      <section class="list-card" data-enter>
        <div class="row">
          <span class="row-icon"><Icon name="user" size={19} /></span>
          <div class="row-main"><span class="row-title">Usuario</span><span class="row-sub">{ctx.username}</span></div>
        </div>
        {ctx.organization && (
          <div class="row">
            <span class="row-icon"><Icon name="route" size={19} /></span>
            <div class="row-main"><span class="row-title">Código de ruta</span><span class="row-sub">{ctx.organization.code}</span></div>
          </div>
        )}
        {ctx.subscription_ends_at && ctx.role === 'admin' && (
          <div class="row">
            <span class="row-icon"><Icon name="calendar" size={19} /></span>
            <div class="row-main"><span class="row-title">Suscripción activa hasta</span><span class="row-sub">{fmtDate(ctx.subscription_ends_at, { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
          </div>
        )}
        <PushRow />
        <button type="button" class="row row-button" onClick={() => setPwOpen(true)}>
          <span class="row-icon"><Icon name="key" size={19} /></span>
          <div class="row-main"><span class="row-title">Cambiar contraseña</span></div>
          <Icon name="chevron" size={18} class="row-chevron" />
        </button>
      </section>

      <div data-enter class="only-mobile">
        <Button variant="ghost" icon="logout" class="btn-block" onClick={logout}>Cerrar sesión</Button>
      </div>

      <ChangePasswordSheet open={pwOpen} onClose={() => setPwOpen(false)} />
    </>
  );
}
