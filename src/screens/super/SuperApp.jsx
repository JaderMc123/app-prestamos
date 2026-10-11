import { usePath, match, navigate } from '../../lib/router.jsx';
import { AppShell } from '../../components/Shell.jsx';
import { Notifications } from '../shared/Notifications.jsx';
import { Profile } from '../shared/Profile.jsx';
import { Rutas } from './Rutas.jsx';
import { RutaDetalle } from './RutaDetalle.jsx';
import { Logs } from './Logs.jsx';
import { Plataforma } from './Plataforma.jsx';
import { superSheets } from './sheets.js';

// Acá están las pantallas y el menú del súper admin
const NAV = [
  { href: '/', label: 'Rutas', icon: 'route' },
  { href: '/logs', label: 'Logs', icon: 'logs' },
  { href: '/plataforma', label: 'Plataforma', icon: 'settings' },
  { href: '/perfil', label: 'Perfil', icon: 'user' }
];

const ROUTES = [
  { path: '/', view: Rutas },
  { path: '/rutas/:id', view: RutaDetalle },
  { path: '/logs', view: Logs },
  { path: '/plataforma', view: Plataforma },
  { path: '/notificaciones', view: Notifications },
  { path: '/perfil', view: Profile }
];

const newRoute = () => {
  navigate('/');
  superSheets.set({ newRoute: true });
};

export default function SuperApp() {
  const path = usePath();
  const m = match(ROUTES, path) || ROUTES[0];
  const View = m.view;
  return (
    <AppShell nav={NAV} fab={{ label: 'Nueva ruta', icon: 'plus', onClick: newRoute }}>
      <View params={m.params} />
    </AppShell>
  );
}
