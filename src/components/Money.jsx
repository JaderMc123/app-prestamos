import { useLayoutEffect, useRef } from 'preact/hooks';
import { copParts } from '../lib/money.js';
import { countTo } from '../lib/motion.js';

// Monto grande: los últimos tres dígitos se muestran más pequeños (como en la referencia de diseño)
export function Money({ value, size = 'hero', animate = true, hidden = false, class: cls = '' }) {
  const mainRef = useRef(null);
  const tailRef = useRef(null);
  const lastValue = useRef(0);
  const [main, tail] = copParts(value);

  useLayoutEffect(() => {
    if (hidden || !animate || !mainRef.current) return;
    const from = lastValue.current;
    lastValue.current = value;
    // Se anima el número completo y se separa en sus dos partes en cada cuadro
    const tween = countTo(mainRef.current, value, {
      from,
      duration: from === 0 ? 1 : 0.6,
      format: (v) => {
        const [m, t] = copParts(v);
        if (tailRef.current) tailRef.current.textContent = t;
        return m;
      }
    });
    return () => tween?.kill?.();
  }, [value, hidden, animate]);

  if (hidden) {
    return (
      <span class={`money money-${size} num ${cls}`} aria-label="Monto oculto">
        <span>$•••••</span>
      </span>
    );
  }

  return (
    <span class={`money money-${size} num ${cls}`} aria-label={main + tail}>
      <span ref={mainRef} aria-hidden="true">{main}</span>
      <span ref={tailRef} class="money-tail" aria-hidden="true">{tail}</span>
    </span>
  );
}
