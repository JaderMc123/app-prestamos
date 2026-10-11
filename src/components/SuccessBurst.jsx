import { useLayoutEffect, useRef } from 'preact/hooks';
import { gsap, reducedMotion, countTo } from '../lib/motion.js';
import { haptic } from '../lib/native.js';
import { cop } from '../lib/money.js';

// Acá se configura la animación de "cobro registrado": círculo lima, check dibujado y monto contando
export function SuccessBurst({ amount, title = 'Cobro registrado', detail, queued, onDone }) {
  const root = useRef(null);

  useLayoutEffect(() => {
    haptic('success');
    const el = root.current;
    const amountEl = el.querySelector('.burst-amount');
    if (reducedMotion()) {
      amountEl.textContent = cop(amount);
      const t = setTimeout(onDone, 1600);
      return () => clearTimeout(t);
    }
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ onComplete: () => setTimeout(onDone, 900) });
      tl.from('.burst-bg', { autoAlpha: 0, duration: 0.2 })
        .fromTo('.burst-disc', { scale: 0 }, { scale: 1, duration: 0.55, ease: 'back.out(1.7)' }, 0.05)
        .fromTo('.burst-ring', { scale: 0.6, autoAlpha: 0.9 }, { scale: 1.9, autoAlpha: 0, duration: 0.9, ease: 'power2.out' }, 0.15)
        .fromTo('.burst-check', { strokeDashoffset: 48 }, { strokeDashoffset: 0, duration: 0.42, ease: 'power2.out' }, 0.35)
        .add(() => countTo(amountEl, amount, { duration: 0.7, format: cop }), 0.4)
        .from('.burst-text > *', { y: 12, autoAlpha: 0, stagger: 0.06, duration: 0.4 }, 0.45);
    }, el);
    return () => ctx.revert();
  }, []);

  return (
    <div ref={root} class="burst" role="status" aria-live="assertive" onClick={onDone}>
      <div class="burst-bg" />
      <div class="burst-stage">
        <span class="burst-ring" />
        <span class="burst-disc">
          <svg viewBox="0 0 24 24" width="56" height="56" fill="none" aria-hidden="true">
            <path class="burst-check" d="M5 12.5 10 17.5 19 7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="48" />
          </svg>
        </span>
      </div>
      <div class="burst-text">
        <p class="burst-title">{title}</p>
        <p class="burst-amount num">{cop(0)}</p>
        {detail && <p class="muted">{detail}</p>}
        {queued && <p class="burst-queued">Sin señal: se enviará cuando vuelva la conexión</p>}
      </div>
    </div>
  );
}
