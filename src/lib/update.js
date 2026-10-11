import { registerSW } from 'virtual:pwa-register';

// Acá se revisa si hay una versión nueva de la app al abrirla (útil cuando está anclada al inicio del iPhone)
const MAX_WAIT = 5000;

function showUpdating() {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.remove('out');
  const msg = document.getElementById('boot-msg');
  if (msg) msg.textContent = 'Actualizando la app…';
}

// Espera a que termine la revisión: si hay versión nueva, la instala y recarga UNA sola vez
export function checkForUpdate() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV || window.Capacitor?.isNativePlatform?.()) return Promise.resolve();
  // Primera vez que se abre: no hay versión anterior que reemplazar, se registra sin esperar
  const firstInstall = !navigator.serviceWorker.controller;
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };

    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        // Versión nueva lista: se muestra el aviso y se recarga con ella
        showUpdating();
        updateSW(true);
      },
      onRegisteredSW(_url, reg) {
        if (!reg || firstInstall) finish();
        if (!reg) return;
        reg
          .update()
          .then(() => {
            const pending = reg.installing || reg.waiting;
            if (!pending || firstInstall) return finish();
            showUpdating();
            if (reg.waiting) updateSW(true);
          })
          .catch(finish);

        // Al volver a la app desde segundo plano se revisa de nuevo
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      },
      onRegisterError: finish
    });

    // Sin señal o servidor lento: no se bloquea la app
    setTimeout(finish, MAX_WAIT);
  });
}
