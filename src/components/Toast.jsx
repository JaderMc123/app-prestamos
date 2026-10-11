import { useLayoutEffect, useRef } from 'preact/hooks';
import { createStore, useStore } from '../lib/store.js';
import { gsap, reducedMotion } from '../lib/motion.js';
import { haptic } from '../lib/native.js';
import { Icon } from './Icon.jsx';

// Acá están los avisos cortos que aparecen arriba (guardado, error, etc.)
const toasts = createStore({ list: [] });
let seq = 0;

export function toast(text, tone = 'ok') {
  const id = ++seq;
  if (tone === 'error') haptic('error');
  toasts.set((s) => ({ list: [...s.list.slice(-2), { id, text, tone }] }));
  setTimeout(() => toasts.set((s) => ({ list: s.list.filter((t) => t.id !== id) })), tone === 'error' ? 4500 : 2800);
}

function ToastItem({ t }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (!reducedMotion()) gsap.from(ref.current, { y: -16, autoAlpha: 0, scale: 0.96, duration: 0.4, ease: 'back.out(2)' });
  }, []);
  return (
    <div ref={ref} class={`toast toast-${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
      <Icon name={t.tone === 'error' ? 'alert' : t.tone === 'info' ? 'bell' : 'check'} size={18} />
      <span>{t.text}</span>
    </div>
  );
}

export function Toaster() {
  const list = useStore(toasts, (s) => s.list);
  return (
    <div class="toaster" aria-live="polite">
      {list.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}
