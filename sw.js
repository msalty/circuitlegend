/* Circuit Legend service worker.
   Scope is the directory this file is served from, so the app can
   live at /breakers/ alongside other PWAs on the same origin.
   Cache names are namespaced to avoid colliding with sibling apps. */
const CACHE = 'circuitlegend-v2';
const ASSETS = ['./', './index.html', './app.js', './manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      /* `&&` binds tighter than `||`, so without the parentheses the cache
         that was just precached on install is deleted on activate. */
      .then(ks => Promise.all(ks.filter(k => (k.startsWith('circuitlegend-') || k.startsWith('panelbook-')) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
