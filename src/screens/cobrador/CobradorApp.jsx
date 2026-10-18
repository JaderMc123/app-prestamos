import { useStore } from '../../lib/store.js';
import { session } from '../../lib/session.js';
import { useQuery } from '../../lib/query.js';
import { usePath, match } from '../../lib/router.jsx';
import { AppShell } from '../../components/Shell.jsx';
import { Notifications } from '../shared/Notifications.jsx';
import { Profile } from '../shared/Profile.jsx';
import { Movimientos } from '../shared/Movimientos.jsx';
import { Clientes, ClientFormHost } from '../shared/clients/Clientes.jsx';
import { CobrarSheet } from './CobrarSheet.jsx';
import { GastoSheet } from './GastoSheet.jsx';
import { Home } from './Home.jsx';
import { Ruta } from './Ruta.jsx';
import { fetchRoute } from './data.js';
import { sheets, openCobrar } from './sheets.js';

// Acá están las pantallas y el menú del cobrador
const NAV = [
  { href: '/', label: 'Inicio', icon: 'home' },
  { href: '/ruta', label: 'Ruta', icon: 'route' },
  { href: '/clientes', label: 'Clientes', icon: 'users' },
  { href: '/movimientos', label: 'Movimientos', icon: 'logs' },
  { href: '/perfil', label: 'Perfil', icon: 'user', mobile: false }
];

const ROUTES = [
  { path: '/', view: Home },
  { path: '/ruta', view: Ruta },
  { path: '/clientes', view: Clientes },
  { path: '/movimientos', view: Movimientos },
  { path: '/notificaciones', view: Notifications },
  { path: '/perfil', view: Profile }
];

export function useRoute() {
  const userId = useStore(session, (s) => s.user?.id);
  return useQuery(`route:${userId}`, () => fetchRoute(userId), { persist: true });
}

export default function CobradorApp() {
  const path = usePath();
  const s = useStore(sheets);
  const route = useRoute();
  const m = match(ROUTES, path) || ROUTES[0];
  const View = m.view;

  return (
    <AppShell nav={NAV} fab={{ label: 'Cobrar', icon: 'scan', onClick: () => openCobrar() }}>
      <View params={m.params} route={route} />
      <CobrarSheet open={s.cobrar} preset={s.preset} items={route.data?.items || []} onClose={() => sheets.set({ cobrar: false, preset: null })} />
      <GastoSheet open={s.gasto} onClose={() => sheets.set({ gasto: false })} />
      <ClientFormHost />
    </AppShell>
  );
}
