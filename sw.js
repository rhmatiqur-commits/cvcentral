/**
 * CV Central — Service Worker
 * App-shell caching so the PWA installs cleanly and loads instantly on
 * repeat visits / flaky connections. Never caches API calls, Supabase,
 * or Stripe requests — those always need a live network round-trip.
 */

// IMPORTANT: bump this whenever any file listed in APP_SHELL changes.
// The worker only re-runs install() when this file's bytes change, so an
// edit to a precached page with the version left alone leaves every client
// holding the previous copy — that is exactly how the fixed cv-builder.html
// failed to reach users who had installed v2 beforehand.
//
// v2 — landing page redesign ('/' and '/index.html' gained landing.css/js)
// v3 — cv-builder.html renderTags fix
const CACHE_VERSION = 'cvcentral-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/cv-builder.html',
  '/login.html',
  '/signup.html',
  '/styles/landing.css',
  '/styles/main.css',
  '/styles/builder.css',
  '/js/landing.js',
  '/js/auth.js',
  '/js/chatbot.js',
  '/assets/logo-icon.svg',
  '/assets/logo.svg',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isNeverCache(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('stripe.com') ||
    url.hostname.includes('stripe.network')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (isNeverCache(url)) return; // let it hit the network untouched

  // Navigations: network-first, fall back to cached shell page (offline support)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/dashboard.html')))
    );
    return;
  }

  // Static assets: cache-first, update cache in background
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
