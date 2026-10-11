import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { gsap, reducedMotion } from '../lib/motion.js';
import { Icon } from './Icon.jsx';

// Panel deslizable: en el celular sube desde abajo; en escritorio entra por la derecha
const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;

export function Sheet({ open, onClose, title, subtitle, children, footer, size = 'md' }) {
  const panel = useRef(null);
  const backdrop = useRef(null);
  const closing = useRef(false);

  // Acá se configura la animación de entrada del panel
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    closing.current = false;
    document.documentElement.classList.add('no-scroll');
    if (reducedMotion()) return;
    const desk = isDesktop();
    const tl = gsap.timeline();
    tl.fromTo(backdrop.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: 'power1.out' }, 0);
    tl.fromTo(
      panel.current,
      desk ? { x: 48, autoAlpha: 0 } : { yPercent: 100 },
      desk ? { x: 0, autoAlpha: 1, duration: 0.42, ease: 'power3.out' } : { yPercent: 0, duration: 0.5, ease: 'expo.out' },
      0
    );
    tl.from(panel.current.querySelectorAll('[data-enter]'), { y: 10, autoAlpha: 0, stagger: 0.035, duration: 0.35, clearProps: 'all' }, 0.12);
    return () => tl.kill();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    const first = panel.current?.querySelector('input, select, textarea');
    if (first && isDesktop()) setTimeout(() => first.focus(), 300);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('no-scroll');
    };
  }, [open]);

  // Animación de salida antes de cerrar
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    if (reducedMotion() || !panel.current) return onClose();
    const desk = isDesktop();
    gsap.to(backdrop.current, { autoAlpha: 0, duration: 0.2 });
    gsap.to(panel.current, desk ? { x: 48, autoAlpha: 0, duration: 0.25, ease: 'power2.in', onComplete: onClose } : { yPercent: 100, duration: 0.3, ease: 'power2.in', onComplete: onClose });
  };

  // Arrastrar hacia abajo para cerrar (solo celular)
  const drag = useRef(null);
  const onPointerDown = (e) => {
    if (isDesktop()) return;
    drag.current = { y0: e.clientY, dy: 0, t0: Date.now() };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y0);
    gsap.set(panel.current, { y: drag.current.dy });
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    const { dy, t0 } = drag.current;
    drag.current = null;
    const fast = dy / Math.max(1, Date.now() - t0) > 0.6;
    if (dy > 120 || (fast && dy > 30)) close();
    else gsap.to(panel.current, { y: 0, duration: 0.35, ease: 'back.out(2)' });
  };

  if (!open) return null;

  return (
    <div class="sheet-root" role="dialog" aria-modal="true" aria-label={title}>
      <div ref={backdrop} class="sheet-backdrop" onClick={close} />
      <div ref={panel} class={`sheet sheet-${size}`}>
        <div class="sheet-grab" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <span class="sheet-handle" />
        </div>
        <header class="sheet-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p class="muted">{subtitle}</p>}
          </div>
          <button type="button" class="icon-btn icon-btn-ghost" aria-label="Cerrar" onClick={close}>
            <Icon name="x" size={20} />
          </button>
        </header>
        <div class="sheet-body">{children}</div>
        {footer && <footer class="sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}
