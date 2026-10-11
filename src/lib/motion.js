import { gsap } from 'gsap';
import { useLayoutEffect, useRef } from 'preact/hooks';

// Acá se configuran las animaciones de la app (GSAP)
export { gsap };

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

gsap.defaults({ ease: 'power3.out', duration: 0.45 });

// Ejecuta animaciones dentro de un contexto que se limpia solo al salir de la pantalla
export function useMotion(setup, deps = []) {
  const scope = useRef(null);
  useLayoutEffect(() => {
    if (!scope.current || reducedMotion()) return;
    const ctx = gsap.context(() => setup(scope.current), scope.current);
    return () => ctx.revert();
  }, deps);
  return scope;
}

// Entrada en cascada de los elementos marcados con data-enter
export function enterStagger(root, selector = '[data-enter]') {
  const items = root.querySelectorAll(selector);
  if (!items.length) return;
  gsap.from(items, { y: 14, autoAlpha: 0, duration: 0.5, stagger: 0.045, clearProps: 'transform,opacity,visibility' });
}

// Cuenta un número de 0 al valor final escribiendo directo en el DOM (sin re-renderizar)
export function countTo(el, to, { from = 0, duration = 0.9, format = (v) => String(Math.round(v)) } = {}) {
  if (!el) return;
  if (reducedMotion()) {
    el.textContent = format(to);
    return;
  }
  const o = { v: from };
  return gsap.to(o, {
    v: to,
    duration,
    ease: 'power2.out',
    onUpdate: () => (el.textContent = format(o.v))
  });
}

// Pequeño "apretón" al tocar un botón importante
export function press(el) {
  if (!el || reducedMotion()) return;
  gsap.fromTo(el, { scale: 0.94 }, { scale: 1, duration: 0.4, ease: 'back.out(3)' });
}
