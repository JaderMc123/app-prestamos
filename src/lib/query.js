import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

// Acá se cargan los datos: muestra lo guardado al instante y actualiza en segundo plano
const memory = new Map();
const inflight = new Map();
const listeners = new Map();

function readDisk(key) {
  try {
    return JSON.parse(localStorage.getItem('q:' + key));
  } catch {
    return null;
  }
}

function writeDisk(key, data) {
  try {
    localStorage.setItem('q:' + key, JSON.stringify(data));
  } catch {}
}

export function invalidate(prefix) {
  for (const [key, fns] of listeners) if (typeof key === 'string' && key.startsWith(prefix)) fns.forEach((fn) => fn());
}

export function useQuery(key, fetcher, { persist = false } = {}) {
  const initial = memory.get(key) ?? (persist ? readDisk(key) : null);
  const [data, setData] = useState(initial);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(initial == null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async () => {
    if (!key) return;
    setError(null);
    let p = inflight.get(key);
    if (!p) {
      p = fetcherRef.current();
      inflight.set(key, p);
    }
    try {
      const value = await p;
      memory.set(key, value);
      if (persist) writeDisk(key, value);
      setData(value);
    } catch (err) {
      setError(err);
    } finally {
      inflight.delete(key);
      setLoading(false);
    }
  }, [key, persist]);

  useEffect(() => {
    // Consulta desactivada (sin clave): no carga ni se registra
    if (!key) {
      setLoading(false);
      return;
    }
    const cached = memory.get(key) ?? (persist ? readDisk(key) : null);
    setData(cached);
    setLoading(cached == null);
    load();
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(load);
    return () => listeners.get(key)?.delete(load);
  }, [key]);

  return { data, error, loading, reload: load };
}
