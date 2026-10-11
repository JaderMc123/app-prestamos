import { createStore, useStore } from './store.js';

// Acá está la navegación entre pantallas (router mínimo, sin librerías)
const route = createStore({ path: location.pathname });

export function navigate(path, { replace = false } = {}) {
  if (path === route.get().path) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route.set({ path });
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => route.set({ path: location.pathname }));

export const usePath = () => useStore(route, (s) => s.path);

export function Link({ href, children, ...rest }) {
  const onClick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}

// Busca la pantalla que corresponde a la ruta; soporta parámetros como /rutas/:id
export function match(routes, path) {
  for (const r of routes) {
    const keys = [];
    const re = new RegExp('^' + r.path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    const m = path.match(re);
    if (m) return { ...r, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
