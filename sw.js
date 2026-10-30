const CACHE_NAME = "stock-scanner-v32";
const APP_SHELL = [
  "./",
  "./index.html",
  "./src/app.js?v=32",
  "./src/api.js?v=32",
  "./src/auth.js",
  "./src/catalog.js?v=32",
  "./src/config.js?v=32",
  "./src/debug.js",
  "./src/queue.js",
  "./src/scanner.js?v=32",
  "./src/ui.js?v=32",
  "./src/styles.css?v=32",
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
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(fetch(event.request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    })
    .catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === "navigate") return caches.match("./index.html");
      return Response.error();
    }));
});
