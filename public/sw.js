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
    const data = event.notification.data || {};
    const targetUrl = event.action === 'contact-adviser' && data.contactUrl
      ? data.contactUrl
      : (data.url || '/admin/notifications?app=1');
    for (const client of allClients) {
      if ('focus' in client) {
        if (targetUrl.startsWith('mailto:') || targetUrl.startsWith('sms:') || targetUrl.startsWith('tel:')) {
          return client.postMessage({ type: 'edutrack-open-url', url: targetUrl });
        }
        client.navigate(targetUrl);
        return client.focus();
      }
    }
    if (clients.openWindow) {
      return clients.openWindow(targetUrl);
    }
  })());
});
