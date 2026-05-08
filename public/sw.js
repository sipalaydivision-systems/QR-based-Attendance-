self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const targetUrl = '/admin/notifications';
    for (const client of allClients) {
      if ('focus' in client) {
        client.navigate(targetUrl);
        return client.focus();
      }
    }
    if (clients.openWindow) {
      return clients.openWindow(targetUrl);
    }
  })());
});
