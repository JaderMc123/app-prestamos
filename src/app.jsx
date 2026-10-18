import { Component } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { logError } from './lib/api.js';
import { useStore } from './lib/store.js';
import { session } from './lib/session.js';
import { Login } from './screens/auth/Login.jsx';
import { Locked } from './screens/shared/Locked.jsx';
import { TratamientoDatos } from './screens/shared/TratamientoDatos.jsx';
import { usePath } from './lib/router.jsx';
import { Toaster } from './components/Toast.jsx';
import { startNotifications, stopNotifications } from './screens/shared/notifications.js';

// Acá se decide qué app cargar según el rol; cada rol descarga solo su propio código
const LOADERS = {
  super_admin: () => import('./screens/super/SuperApp.jsx'),
  admin: () => import('./screens/admin/AdminApp.jsx'),
  cobrador: () => import('./screens/cobrador/CobradorApp.jsx')
};

function RoleApp({ role }) {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    let alive = true;
    LOADERS[role]?.()
      .then((m) => {
        try {
          sessionStorage.removeItem('reload-once');
        } catch {}
        if (alive) setComp(() => m.default);
      })
      .catch((err) => {
        // Si la app se actualizó y faltan archivos viejos, se recarga una sola vez
        logError(err, { where: 'carga-rol' });
        try {
          if (!sessionStorage.getItem('reload-once')) {
            sessionStorage.setItem('reload-once', '1');
            location.reload();
          }
        } catch {}
      });
    return () => (alive = false);
  }, [role]);
  return Comp ? <Comp /> : <div class="page-loading"><span class="boot-mark" /></div>;
}

// Si una pantalla falla, se muestra un aviso con opción de recargar en vez de dejar la app en blanco
class ErrorBoundary extends Component {
  state = { error: null };
  componentDidUpdate(prev) {
    if (prev.path !== this.props.path && this.state.error) this.setState({ error: null });
  }
  componentDidCatch(error) {
    logError(error, { where: 'pantalla', path: location.pathname });
    this.setState({ error });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div class="crash">
        <span class="boot-mark" />
        <h1>Algo salió mal</h1>
        <p class="muted">Tus datos están guardados. Recarga la app para seguir trabajando.</p>
        <button type="button" class="btn btn-lime btn-lg" onClick={() => location.reload()}><span>Recargar</span></button>
        <button type="button" class="link-btn" onClick={() => { this.setState({ error: null }); history.replaceState(null, '', '/'); location.reload(); }}>Ir al inicio</button>
      </div>
    );
  }
}

export function App() {
  const { status, ctx, user } = useStore(session);
  const path = usePath();

  // Quita la pantalla de arranque cuando ya se sabe si hay sesión
  useEffect(() => {
    if (status !== 'loading') document.getElementById('boot')?.classList.add('out');
  }, [status]);

  useEffect(() => {
    if (status === 'in' && user?.id) startNotifications(user.id);
    else stopNotifications();
  }, [status, user?.id]);

  let view = null;
  if (path === '/tratamiento-datos') view = <TratamientoDatos />;
  else if (status === 'out') view = <Login />;
  else if (status === 'in') view = ctx.access_level === 'blocked' ? <Locked ctx={ctx} /> : <RoleApp role={ctx.role} />;

  return (
    <>
      <ErrorBoundary path={path}>{view}</ErrorBoundary>
      <Toaster />
    </>
  );
}
