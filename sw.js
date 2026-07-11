// sw.js — 오프라인 캐시 (앱 셸)
const CACHE = 'antihum-final-6';
const ASSETS = ['./', './index.html', './style.css', './app.js', './ui.js',
  './pipeline.js', './engine.js', './dsp.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request))
  );
});
