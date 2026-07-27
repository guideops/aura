// AURA shell service worker.
//
// Deliberately dumb: no build-time precache manifest to keep in sync. Vite's
// hashed asset filenames make cache-first safe for /shell/assets, while
// navigations stay network-first so a deploy is picked up on the next load and
// the cached copy only serves as the offline fallback. Icons keep stable names,
// so they are stale-while-revalidate instead — a replaced icon self-heals on
// the following load rather than sticking until the cache version changes.
// API and websocket traffic is never touched.

const CACHE = "aura-shell-v2";
const SCOPE = new URL(self.registration.scope).pathname; // "/shell/"
const OFFLINE_FALLBACK = SCOPE;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([SCOPE])).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isHashedAsset = (url) => url.pathname.startsWith(`${SCOPE}assets/`);
const isIcon = (url) => url.pathname.startsWith(`${SCOPE}icons/`);

function cacheFirst(request) {
  return caches.match(request).then(
    (hit) =>
      hit ??
      fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }),
  );
}

function staleWhileRevalidate(request) {
  return caches.match(request).then((hit) => {
    const fresh = fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      // Offline revalidation is expected to fail; the cached hit already served.
      .catch(() => hit ?? Response.error());
    return hit ?? fresh;
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(OFFLINE_FALLBACK, copy));
          return response;
        })
        .catch(() => caches.match(OFFLINE_FALLBACK).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  if (isHashedAsset(url)) event.respondWith(cacheFirst(request));
  else if (isIcon(url)) event.respondWith(staleWhileRevalidate(request));
});
