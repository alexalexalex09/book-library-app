const SHELL_CACHE = "shelfmapper-shell-v1";
const RUNTIME_CACHE = "shelfmapper-runtime-v1";

const APP_SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/css/style.css",
  "/js/api.js",
  "/js/app.js",
  "/js/legal.js",
  "/js/offline-store.js",
  "/js/pwa.js",
  "/img/ShelfMapperLogo.svg",
  "/img/noun_Crop_1935400.svg",
  "/img/logo-180.png",
  "/img/logo-192.png",
  "/img/logo-512.png",
  "/img/logo-maskable-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        APP_SHELL_URLS.map(async (url) => {
          try {
            await cache.add(url);
          } catch (error) {
            // External resources can fail transiently; keep install resilient.
            console.warn("[sw] cache add failed:", url, error);
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function normalizedRequest(request) {
  const url = new URL(request.url);
  url.hash = "";
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    return;
  }

  const isScript = url.origin === self.location.origin && url.pathname.endsWith(".js");
  if (isScript) {
    event.respondWith(
      (async () => {
        const key = normalizedRequest(request);
        try {
          const networkResponse = await fetch(request);
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(key, networkResponse.clone()).catch(() => {});
          return networkResponse;
        } catch {
          const cached = await caches.match(key);
          if (cached) return cached;
          throw new Error("Script fetch failed and no cache available");
        }
      })(),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put("/index.html", networkResponse.clone()).catch(() => {});
          return networkResponse;
        } catch {
          return (
            (await caches.match("/index.html")) ||
            (await caches.match("/")) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  const isStaticSameOrigin =
    url.origin === self.location.origin &&
    (/^\/(css|js|img)\//.test(url.pathname) ||
      url.pathname === "/manifest.webmanifest" ||
      url.pathname.endsWith(".css") ||
      url.pathname.endsWith(".js") ||
      url.pathname.endsWith(".svg") ||
      url.pathname.endsWith(".png") ||
      url.pathname.endsWith(".webmanifest"));

  if (!isStaticSameOrigin) return;

  event.respondWith(
    (async () => {
      const key = normalizedRequest(request);
      const cached = await caches.match(key);
      if (cached) return cached;

      const response = await fetch(request);
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(key, response.clone()).catch(() => {});
      return response;
    })(),
  );
});
