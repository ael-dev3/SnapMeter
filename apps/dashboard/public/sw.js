const CACHE = "snapmeter-shell-v2";
const SHELL = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    const network = fetch(request);
    event.waitUntil(network.then((response) => response.ok
      ? caches.open(CACHE).then((cache) => cache.put("/", response.clone()))
      : undefined).catch(() => undefined));
    event.respondWith(network.catch(() => caches.match("/").then((response) => response || Response.error())));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then(async (response) => {
      if (response.ok) await caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    }))
  );
});
