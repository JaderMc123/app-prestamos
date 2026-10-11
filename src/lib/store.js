import { useEffect, useState } from 'preact/hooks';

// Acá está el estado global liviano de la app (sin librerías externas)
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      state = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
      subs.forEach((fn) => fn(state));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    }
  };
}

// Se suscribe solo a la parte del estado que el componente necesita
export function useStore(store, select = (s) => s) {
  const [value, setValue] = useState(() => select(store.get()));
  useEffect(() => {
    const unsub = store.subscribe((s) => setValue(select(s)));
    // Por si el estado cambió entre el primer render y la suscripción
    setValue(select(store.get()));
    return unsub;
  }, [store]);
  return value;
}
