import { logout, refreshContext } from '../../lib/session.js';
import { useMotion, gsap } from '../../lib/motion.js';
import { Button } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';

// Pantalla cuando la ruta está suspendida o el usuario fue desactivado
export function Locked({ ctx }) {
  const scope = useMotion((root) => {
    gsap.from(root.querySelector('.locked-icon'), { scale: 0.5, autoAlpha: 0, duration: 0.7, ease: 'back.out(2)' });
    gsap.from(root.querySelectorAll('[data-enter]'), { y: 14, autoAlpha: 0, stagger: 0.07, delay: 0.2 });
  });
  return (
    <div ref={scope} class="locked">
      <span class="locked-icon"><Icon name="lock" size={34} /></span>
      <h1 data-enter>Sin acceso</h1>
      <p class="muted" data-enter>{ctx?.message || 'No tienes acceso en este momento.'}</p>
      <div class="locked-actions" data-enter>
        <Button variant="lime" icon="sync" onClick={refreshContext}>Volver a intentar</Button>
        <Button variant="ghost" icon="logout" onClick={logout}>Cerrar sesión</Button>
      </div>
    </div>
  );
}
