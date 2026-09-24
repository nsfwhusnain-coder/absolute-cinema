/* Absolute Cinema service worker
 *
 * Strategies:
 * - /api/*                   → never intercepted (live data, streams, auth)
 * - /_next/static, icons     → cache-first (content-hashed, safe forever)
 * - TMDB images              → cache-first, capped at MAX_IMAGE_ENTRIES
 * - navigations              → network-only; a styled offline page on failure
 *
 * Pages are deliberately not cached: they are per-user and change on every
 * deploy, and serving a stale shell for a different URL is worse than an
 * honest offline notice.
 */

const VERSION = "v5";
const STATIC_CACHE = `absolute-cinema-static-${VERSION}`;
const IMAGE_CACHE = `absolute-cinema-images-${VERSION}`;
const MAX_IMAGE_ENTRIES = 300;
const STATIC_ASSETS = ["/manifest.json", "/icon-192.png", "/icon-512.png", "/icon.svg", "/favicon.svg"];

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline · Absolute Cinema</title>
<style>
  html,body{height:100%;margin:0;background:#050508;color:#f4f4f5;font-family:system-ui,-apple-system,sans-serif}
  main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;padding:24px}
  h1{font-size:22px;margin:0} p{margin:0;color:#a1a1aa;max-width:360px;line-height:1.5}
  button{margin-top:8px;background:#fff;color:#050508;border:0;border-radius:999px;padding:10px 22px;font-weight:600;font-size:15px;cursor:pointer}
</style></head><body><main>
  <img src="/icon-192.png" width="64" height="64" alt="">
  <h1>You're offline</h1>
  <p>Absolute Cinema can't reach the server right now. Check your connection and try again.</p>
  <button onclick="location.reload()">Try again</button>
</main></body></html>`;

function isStaticAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    STATIC_ASSETS.includes(pathname) ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".woff2")
  );
}

function isPosterImage(url) {
  return url.hostname === "image.tmdb.org";
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  const keep = new Set([STATIC_CACHE, IMAGE_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) await cache.put(request, res.clone());
  return res;
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

async function posterImage(event) {
  const cache = await caches.open(IMAGE_CACHE);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const res = await fetch(event.request);
  // Only cache readable (CORS) successes: opaque responses are padded to
  // megabytes each by the browser's quota accounting.
  if (res && res.ok && res.type !== "opaque") {
    await cache.put(event.request, res.clone());
    event.waitUntil(trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES));
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (isPosterImage(url) && request.destination === "image") {
    event.respondWith(posterImage(event).catch(() => Response.error()));
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(OFFLINE_HTML, {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      ),
    );
  }
});
