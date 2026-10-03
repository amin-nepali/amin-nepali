const CACHE_NAME = "network-lab-offline-v2";
const APP_SHELL = [
  "/network-lab.html",
  "/network-lab.webmanifest",
  "/network-lab-icon-192.png",
  "/network-lab-icon-512.png",
  "/network-lab-icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("network-lab-offline-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_APP_RESOURCES" || !Array.isArray(event.data.urls)) return;
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        for (const value of event.data.urls) {
          if (typeof value !== "string") continue;
          const url = new URL(value);
          if (url.origin !== self.location.origin || await cache.match(url.href)) continue;
          const response = await fetch(url.href);
          if (!response.ok) throw new Error(`Unable to cache ${url.pathname}: ${response.status}`);
          await cache.put(url.href, response);
        }
        event.ports[0]?.postMessage({ ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown cache error.";
        event.ports[0]?.postMessage({ ok: false, message });
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate" && url.pathname === "/network-lab.html") {
    event.respondWith(
      caches.match(url.pathname + url.search).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname + url.search, copy));
          }
          return response;
        });
      }),
    );
    return;
  }

  if (
    url.pathname.startsWith("/assets/") ||
    APP_SHELL.includes(url.pathname)
  ) {
    event.respondWith(
      caches.match(url.pathname + url.search).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname + url.search, copy));
          }
          return response;
        });
      }),
    );
  }
});
