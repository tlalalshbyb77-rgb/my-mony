/*
 * عامل الخدمة: يخزّن ملفات التطبيق ليعمل دون اتصال.
 * ملاحظة: العامل يعمل فقط عند تقديم الملفات عبر http/https وليس file://.
 */
'use strict';

const CACHE_NAME = 'nadam-wallet-v5';
const APP_SHELL = [
  './',
  'index.html',
  'styles.css',
  'config.js',
  'judge.js',
  'messages.js',
  'character.js',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-512-maskable.png',
  'fonts/tajawal-400-arabic.woff2',
  'fonts/tajawal-400-latin.woff2',
  'fonts/tajawal-500-arabic.woff2',
  'fonts/tajawal-500-latin.woff2',
  'fonts/tajawal-700-arabic.woff2',
  'fonts/tajawal-700-latin.woff2',
  'fonts/tajawal-800-arabic.woff2',
  'fonts/tajawal-800-latin.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // التنقل: نحاول الشبكة أولًا ثم نسخة الصفحة المخزّنة.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // بقية الملفات: من الكاش فورًا ثم نحدّثه في الخلفية.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
