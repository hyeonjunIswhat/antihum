// sw.js — 네트워크 우선: 배포 즉시 반영, 오프라인 시에만 캐시 사용
const CACHE = 'antihum-v15';
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
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
