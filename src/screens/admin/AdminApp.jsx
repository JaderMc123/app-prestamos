import { usePath, match, navigate } from '../../lib/router.jsx';
import { AppShell } from '../../components/Shell.jsx';
import { Notifications } from '../shared/Notifications.jsx';
import { Profile } from '../shared/Profile.jsx';
import { Clientes, ClientFormHost } from '../shared/clients/Clientes.jsx';
import { Dashboard } from './Dashboard.jsx';
import { Cobradores } from './Cobradores.jsx';
import { Ajustes } from './Ajustes.jsx';
import { openNewCollector } from './sheets.js';

// Acá están las pantallas y el menú del administrador
const NAV = [
  { href: '/', label: 'Inicio', icon: 'home' },
  { href: '/cobradores', label: 'Cobradores', icon: 'users' },
  { href: '/clientes', label: 'Clientes', icon: 'pin' },
  { href: '/ajustes', label: 'Ajustes', icon: 'settings' },
  { href: '/perfil', label: 'Perfil', icon: 'user' }
];

const ROUTES = [
  { path: '/', view: Dashboard },
  { path: '/cobradores', view: Cobradores },
  { path: '/clientes', view: Clientes },
  { path: '/ajustes', view: Ajustes },
  { path: '/notificaciones', view: Notifications },
  { path: '/perfil', view: Profile }
];

const newCollector = () => {
  navigate('/cobradores');
  openNewCollector();
};

export default function AdminApp() {
  const path = usePath();
  const m = match(ROUTES, path) || ROUTES[0];
  const View = m.view;
  return (
    <AppShell nav={NAV} fab={{ label: 'Nuevo cobrador', icon: 'plus', onClick: newCollector }}>
      <View params={m.params} />
      <ClientFormHost />
    </AppShell>
  );
}
