import { useState } from 'preact/hooks';
import { login, lastRouteCode } from '../../lib/session.js';
import { useMotion, gsap } from '../../lib/motion.js';
import { haptic } from '../../lib/native.js';
import { Button, Field, PasswordField } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';

// Pantalla de inicio de sesión: código de ruta + usuario + contraseña
export function Login() {
  const [code, setCode] = useState(lastRouteCode());
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Acá se configura la animación de entrada del login
  const scope = useMotion((root) => {
    const tl = gsap.timeline();
    tl.from(root.querySelector('.login-disc'), { scale: 0.4, autoAlpha: 0, duration: 0.9, ease: 'expo.out' })
      .from(root.querySelectorAll('.login-card-row'), { x: -16, autoAlpha: 0, stagger: 0.08, duration: 0.5 }, 0.25)
      .from(root.querySelectorAll('[data-enter]'), { y: 18, autoAlpha: 0, stagger: 0.06, duration: 0.55 }, 0.1);
  });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!code.trim() || !user.trim() || !pass) {
      setError('Completa el código de ruta, el usuario y la contraseña.');
      return;
    }
    setBusy(true);
    try {
      await login(code, user, pass);
      haptic('success');
    } catch (err) {
      setError(err.message);
      haptic('error');
      gsap.fromTo(scope.current.querySelector('.login-form'), { x: -8 }, { x: 0, duration: 0.5, ease: 'elastic.out(1, 0.3)' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={scope} class="login">
      <section class="login-art" aria-hidden="true">
        <span class="login-disc" />
        <div class="login-card">
          <p class="muted">Cobrado hoy</p>
          <p class="login-card-amount num">$186<span>.400</span></p>
          <div class="login-card-row"><span class="status-dot tone-ok" />Marta Rincón<b class="num">$12.000</b></div>
          <div class="login-card-row"><span class="status-dot tone-amber" />Luis Pérez<b class="num">$8.000</b></div>
          <div class="login-card-row"><span class="status-dot tone-coral" />Ana Gómez<b class="num">$15.000</b></div>
        </div>
      </section>

      <section class="login-panel">
        <div class="login-brand" data-enter>
          <span class="brand-mark" aria-hidden="true" />
          <strong>Cobros</strong>
        </div>
        <div data-enter>
          <h1 class="login-title">Inicia sesión</h1>
          <p class="muted">Usa el código de tu ruta y el usuario que te dio tu administrador.</p>
        </div>

        <form class="login-form" onSubmit={submit} noValidate>
          <div data-enter>
            <Field
              label="Código de ruta"
              value={code}
              onInput={(e) => setCode(e.currentTarget.value.toLowerCase().replace(/\s/g, ''))}
              placeholder="ej. rutanorte"
              autocomplete="organization"
              autocapitalize="none"
              spellcheck={false}
              prefix={<Icon name="route" size={18} />}
            />
          </div>
          <div data-enter>
            <Field
              label="Usuario"
              value={user}
              onInput={(e) => setUser(e.currentTarget.value.toLowerCase().replace(/\s/g, ''))}
              placeholder="ej. juan"
              autocomplete="username"
              autocapitalize="none"
              spellcheck={false}
              prefix={<Icon name="user" size={18} />}
            />
          </div>
          <div data-enter>
            <PasswordField
              label="Contraseña"
              value={pass}
              onInput={(e) => setPass(e.currentTarget.value)}
              autocomplete="current-password"
              prefix={<Icon name="key" size={18} />}
            />
          </div>
          {error && (
            <p class="form-error" role="alert">
              <Icon name="alert" size={17} />
              {error}
            </p>
          )}
          <div data-enter>
            <Button type="submit" size="lg" loading={busy} class="btn-block">
              Entrar
            </Button>
          </div>
        </form>
        <p class="login-foot muted" data-enter>¿Olvidaste tu contraseña? Pídele a tu administrador que la restablezca.</p>
      </section>
    </div>
  );
}
