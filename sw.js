/* ═══════════ KLEAN — Service Worker (PWA) ═══════════
   L'app s'installe et reste ouvrable même réseau lent.
   API & temps réel : toujours en direct (jamais de cache). */
const CACHE = 'klean-v17'; // ⚠️ à incrémenter à chaque déploiement (force l'oubli de l'ancien)
const SHELL = [
  '/', '/index.html', '/net.js', '/manifest.json',
  '/klean-icon-192.png', '/klean-icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                                  // jamais de POST en cache
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;  // API & WS : toujours réseau
  // Navigation (pages) : réseau d'abord, cache de secours
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
        .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
    );
    return;
  }
  // Fichiers (icônes, net.js…) : cache d'abord, réseau de secours
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const cp = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, cp));
      return r;
    }))
  );
});

/* ═══ 🔔 Web Push : sonnerie même app fermée / dans la poche ═══ */
self.addEventListener('push', e => {
  let d = { title: '🔔 KLEAN', body: 'Nouvelle demande disponible — touchez pour voir', url: '/?mode=agent', missionId: '' };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: '/klean-icon-192.png',
    badge: '/klean-icon-192.png',
    tag: 'klean-' + (d.missionId || 'info'),
    renotify: true,
    requireInteraction: true,
    vibrate: [260, 120, 260, 120, 420],
    data: { url: d.url },
    actions: [{ action: 'open', title: '📲 Voir la mission' }]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { try { c.navigate(url).catch(()=>{}); } catch(_){} return c.focus(); } }
    return clients.openWindow(url);
  }));
});
