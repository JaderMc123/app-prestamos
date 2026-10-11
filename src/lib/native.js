// Acá se conectan las funciones del teléfono cuando la app corre en Play Store / App Store (Capacitor)
export const isNative = () => !!window.Capacitor?.isNativePlatform?.();

export async function haptic(kind = 'light') {
  try {
    if (isNative()) {
      const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics');
      if (kind === 'success') return Haptics.notification({ type: NotificationType.Success });
      if (kind === 'error') return Haptics.notification({ type: NotificationType.Error });
      return Haptics.impact({ style: kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light });
    }
    if (navigator.vibrate) navigator.vibrate(kind === 'success' ? [12, 60, 18] : kind === 'error' ? [30, 40, 30] : 10);
  } catch {}
}

export async function initNative() {
  if (!isNative()) return;
  try {
    const [{ StatusBar, Style }, { SplashScreen }, { App }] = await Promise.all([
      import('@capacitor/status-bar'),
      import('@capacitor/splash-screen'),
      import('@capacitor/app')
    ]);
    StatusBar.setStyle({ style: Style.Dark });
    SplashScreen.hide();
    // Botón "atrás" de Android: vuelve a la pantalla anterior o minimiza la app
    App.addListener('backButton', ({ canGoBack }) => (canGoBack ? history.back() : App.minimizeApp()));
  } catch {}
}
