import { useEffect, useState } from 'preact/hooks';
import { useStore } from './lib/store.js';
import { session } from './lib/session.js';
import { Login } from './screens/auth/Login.jsx';
import { Locked } from './screens/shared/Locked.jsx';
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
    LOADERS[role]?.().then((m) => alive && setComp(() => m.default));
    return () => (alive = false);
  }, [role]);
  return Comp ? <Comp /> : <div class="page-loading"><span class="boot-mark" /></div>;
}

export function App() {
  const { status, ctx, user } = useStore(session);

  // Quita la pantalla de arranque cuando ya se sabe si hay sesión
  useEffect(() => {
    if (status !== 'loading') document.getElementById('boot')?.classList.add('out');
  }, [status]);

  useEffect(() => {
    if (status === 'in' && user?.id) startNotifications(user.id);
    else stopNotifications();
  }, [status, user?.id]);

  let view = null;
  if (status === 'out') view = <Login />;
  else if (status === 'in') view = ctx.access_level === 'blocked' ? <Locked ctx={ctx} /> : <RoleApp role={ctx.role} />;

  return (
    <>
      {view}
      <Toaster />
    </>
  );
}
