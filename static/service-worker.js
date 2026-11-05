const CACHE_NAME = "prg32-cartridge-store-v3";
const SHELL = [
  "/",
  "/static/style.css",
  "/static/app.js",
  "/static/img/default_logo.svg",
  "/manifest.webmanifest"
];

// Only public pages and static assets are cached for offline use. Signed-in
// pages (admin, account, tokens, review, setup) hold personal data and always
// come from the network, so nothing personal stays in the browser cache.
const PUBLIC_PAGES = [/^\/$/, /^\/games\/[^/]+$/, /^\/scores$/, /^\/stats$/, /^\/privacy$/, /^\/accessibility$/];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  // API answers, downloads and preview videos always come from the network,
  // so a stale cartridge is never installed over USB or shown as current.
  if (url.pathname.startsWith("/api/")) {
    return;
  }
  const isStatic = url.pathname.startsWith("/static/") || url.pathname === "/manifest.webmanifest";
  const isPublicPage = PUBLIC_PAGES.some((pattern) => pattern.test(url.pathname));
  if (!isStatic && !isPublicPage) {
    return;
  }
  event.respondWith(
    fetch(request)
      .then((response) => {
        // A signed-in visitor's copy of a public page can show their name in
        // the header: cache only pages fetched while signed out.
        const cacheable = response.ok && (isStatic || !response.headers.get("X-PRG32-Signed-In"));
        if (cacheable) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
  );
});
