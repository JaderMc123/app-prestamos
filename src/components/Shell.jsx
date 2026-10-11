import { useLayoutEffect, useRef, useState, useEffect } from 'preact/hooks';
import { Link, usePath, navigate } from '../lib/router.jsx';
import { session, logout } from '../lib/session.js';
import { useStore } from '../lib/store.js';
import { outbox } from '../lib/outbox.js';
import { gsap, reducedMotion, press } from '../lib/motion.js';
import { haptic } from '../lib/native.js';
import { Icon } from './Icon.jsx';
import { Avatar } from './ui.jsx';
import { useUnread } from '../screens/shared/notifications.js';

// Acá está la estructura de la app: menú lateral en escritorio y barra inferior en el celular
const ROLE_LABEL = { super_admin: 'Súper admin', admin: 'Administrador', cobrador: 'Cobrador' };

function isActive(path, href) {
  return href === '/' ? path === '/' : path === href || path.startsWith(href + '/');
}

function Fab({ fab }) {
  const ref = useRef(null);
  return (
    <button
      ref={ref}
      type="button"
      class="fab"
      aria-label={fab.label}
      onClick={() => {
        press(ref.current);
        haptic('medium');
        fab.onClick();
      }}
    >
      <Icon name={fab.icon} size={26} stroke={2} />
    </button>
  );
}

function TabBar({ nav, fab, path }) {
  const half = Math.ceil(nav.length / 2);
  const item = (n) => (
    <Link href={n.href} class={`tab ${isActive(path, n.href) ? 'is-active' : ''}`} aria-current={isActive(path, n.href) ? 'page' : undefined}>
      <Icon name={n.icon} size={22} />
      <span>{n.label}</span>
    </Link>
  );
  return (
    <nav class="tabbar" aria-label="Navegación principal" style={{ gridTemplateColumns: `repeat(${nav.length + (fab ? 1 : 0)}, 1fr)` }}>
      {nav.slice(0, half).map(item)}
      {fab && <Fab fab={fab} />}
      {nav.slice(half).map(item)}
    </nav>
  );
}

function Sidebar({ nav, fab, path, ctx }) {
  const unread = useUnread();
  return (
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true" />
        <div>
          <strong>Cobros</strong>
          <span class="muted">{ctx.organization?.name || 'Plataforma'}</span>
        </div>
      </div>
      {fab && (
        <button type="button" class="side-cta" onClick={fab.onClick}>
          <Icon name={fab.icon} size={20} stroke={2} />
          <span>{fab.label}</span>
        </button>
      )}
      <nav class="side-nav" aria-label="Navegación principal">
        {nav.map((n) => (
          <Link href={n.href} class={`side-link ${isActive(path, n.href) ? 'is-active' : ''}`} aria-current={isActive(path, n.href) ? 'page' : undefined}>
            <Icon name={n.icon} size={20} />
            <span>{n.label}</span>
            {n.href === '/notificaciones' && unread > 0 && <span class="side-badge">{unread > 9 ? '9+' : unread}</span>}
          </Link>
        ))}
        {!nav.some((n) => n.href === '/notificaciones') && (
          <Link href="/notificaciones" class={`side-link ${isActive(path, '/notificaciones') ? 'is-active' : ''}`}>
            <Icon name="bell" size={20} />
            <span>Notificaciones</span>
            {unread > 0 && <span class="side-badge">{unread > 9 ? '9+' : unread}</span>}
          </Link>
        )}
      </nav>
      <div class="side-user">
        <Avatar name={ctx.full_name} tone="lime" size={40} />
        <div class="side-user-text">
          <strong>{ctx.full_name}</strong>
          <span class="muted">{ROLE_LABEL[ctx.role]}</span>
        </div>
        <button type="button" class="icon-btn icon-btn-ghost" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={logout}>
          <Icon name="logout" size={19} />
        </button>
      </div>
    </aside>
  );
}

// Aviso de suscripción (por vencer, días de gracia o solo lectura)
function SubscriptionBanner({ ctx }) {
  if (!ctx.message) return null;
  const tone = ctx.access_level === 'readonly' ? 'coral' : ctx.access_level === 'grace' ? 'amber' : 'lav';
  return (
    <div class={`banner banner-${tone}`} role={tone === 'coral' ? 'alert' : 'status'}>
      <Icon name={tone === 'coral' ? 'lock' : 'alert'} size={18} />
      <span>{ctx.message}</span>
    </div>
  );
}

function ConnectionChip() {
  const [online, setOnline] = useState(navigator.onLine);
  const { pending, syncing } = useStore(outbox);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online && !pending) return null;
  return (
    <div class={`conn-chip ${online ? '' : 'is-off'}`} role="status">
      <Icon name={online ? 'sync' : 'offline'} size={16} class={syncing ? 'spin' : ''} />
      <span>{online ? `Enviando ${pending} registro${pending === 1 ? '' : 's'}…` : pending ? `Sin señal, ${pending} por enviar` : 'Sin señal'}</span>
    </div>
  );
}

export function AppShell({ nav, fab, children }) {
  const path = usePath();
  const ctx = useStore(session, (s) => s.ctx);
  const main = useRef(null);

  // Transición suave al cambiar de pantalla
  useLayoutEffect(() => {
    if (reducedMotion() || !main.current) return;
    const ctxG = gsap.context(() => {
      gsap.fromTo(main.current, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.32, ease: 'power2.out', clearProps: 'all' });
      const items = main.current.querySelectorAll('[data-enter]');
      if (items.length) gsap.from(items, { y: 16, autoAlpha: 0, duration: 0.5, stagger: 0.04, delay: 0.05, clearProps: 'all' });
    });
    return () => ctxG.revert();
  }, [path]);

  return (
    <div class="shell">
      <Sidebar nav={nav} fab={fab} path={path} ctx={ctx} />
      <div class="shell-main">
        <SubscriptionBanner ctx={ctx} />
        <ConnectionChip />
        <main ref={main} class="page" key={path}>
          {children}
        </main>
      </div>
      <TabBar nav={nav} fab={fab} path={path} />
    </div>
  );
}

// Encabezado de cada pantalla: saludo/título y campana de notificaciones
export function PageHeader({ eyebrow, title, back, actions }) {
  const unread = useUnread();
  const path = usePath();
  return (
    <header class="page-head" data-enter>
      <div class="page-head-left">
        {back && (
          <button type="button" class="icon-btn icon-btn-solid" aria-label="Volver" onClick={() => (history.length > 1 ? history.back() : navigate(back))}>
            <Icon name="back" size={20} />
          </button>
        )}
        <div>
          {eyebrow && <p class="page-eyebrow">{eyebrow}</p>}
          <h1 class="page-title">{title}</h1>
        </div>
      </div>
      <div class="page-head-actions">
        {actions}
        {path !== '/notificaciones' && (
          <Link href="/notificaciones" class="icon-btn icon-btn-solid only-mobile" aria-label="Notificaciones">
            <Icon name="bell" size={20} />
            {unread > 0 && <span class="dot-badge">{unread > 9 ? '9+' : unread}</span>}
          </Link>
        )}
      </div>
    </header>
  );
}
