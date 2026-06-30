const CACHE_NAME = "stock-scanner-v19";
const APP_SHELL = [
  "./",
  "./index.html",
  "./src/app.js?v=19",
  "./src/api.js",
  "./src/auth.js",
  "./src/config.js",
  "./src/debug.js",
  "./src/queue.js",
  "./src/scanner.js",
  "./src/ui.js",
  "./src/styles.css?v=18",
  "./public/manifest.webmanifest",
  "./public/icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
