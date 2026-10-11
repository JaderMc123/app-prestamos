// Acá el teléfono recibe y muestra las notificaciones aunque la app esté cerrada
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Cobros', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Cobros', {
      body: data.body || '',
      tag: data.tag,
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      data: { url: data.url || '/notificaciones' },
      vibrate: [80, 40, 80]
    })
  );
});

// Al tocar la notificación se abre la app en la pantalla de alertas
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/notificaciones';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate?.(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
