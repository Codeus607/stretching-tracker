// Network-first service worker for the app shell. Videos are never touched: they
// stream with range requests straight from the server.
const CACHE = 'stretching-1791490614';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'stretches.json', 'stretch-192.png', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin
    || url.pathname.endsWith('api.php') || url.pathname.includes('/videos/')) return;
  e.respondWith(fetch(e.request)
    .then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    })
    .catch(() => caches.match(e.request)));
});
