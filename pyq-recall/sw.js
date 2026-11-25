// Offline support: keeps the app itself on the device so it opens without internet.
// Your progress is stored separately (in the app and in Supabase), never in this cache.
const VERSION = 'pyq-recall-v2';
const SB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.109.0/dist/umd/supabase.js';
const FILES = ['./', 'index.html', 'app.js', 'catalogue.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', SB];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.url === SB) { e.respondWith(caches.match(SB).then(r => r || fetch(e.request).then(n => { const c = n.clone(); caches.open(VERSION).then(x => x.put(SB, c)); return n; }))); return; }   // Supabase library: fixed version, keep a copy
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;   // Supabase calls always go to the network
  // network first (so updates arrive), cached copy when offline
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
