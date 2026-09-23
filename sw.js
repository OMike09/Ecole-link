/* 🟠 ÉCOLE LINK — Service Worker : cache doux + notifications poche */
'use strict';
const CACHE = 'ecole-link-v1';
const CORE = ['/', '/index.html', '/ecole-link-icon-192.png', '/ecole-link-icon-512.png'];

self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {})); });
self.addEventListener('activate', e => { e.waitUntil((async () => { const ks = await caches.keys(); await Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))); await self.clients.claim(); })()); });

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/api/')) return;                 // jamais de cache pour les données vivantes
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok && e.request.method === 'GET') { const cl = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cl)).catch(() => {}); }
      return r;
    }).catch(() => caches.match(e.request).then(m => m || caches.match('/')))
  );
});

/* 🔔 Notification même application fermée */
self.addEventListener('push', e => {
  let d = { title: 'ÉCOLE LINK', body: 'Nouvelle alerte de l\'école', url: '/' };
  try { d = { ...d, ...(e.data ? e.data.json() : {}) }; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: '/ecole-link-icon-192.png', badge: '/ecole-link-icon-192.png',
    data: { url: d.url || '/' }, vibrate: [140, 80, 140], tag: 'ecole-link-' + Date.now()
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow((e.notification.data && e.notification.data.url) || '/');
  }));
});
