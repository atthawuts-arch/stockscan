/* StockScan service worker — app-shell offline cache (K).
   - Pre-caches the local app shell (HTML, manifest, icons).
   - Runtime cache-first for CDN modules (esm.sh, jsdelivr) and Google Fonts,
     so the app launches offline after the first online load.
   - Supabase REST/Realtime requests are NEVER cached (the app handles offline
     itself via its localStorage write-queue). */
const VERSION = "stockscan-v1";
const SHELL = "shell-" + VERSION;
const RUNTIME = "runtime-" + VERSION;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

// Cross-origin hosts we may cache at runtime (cache-first).
const RUNTIME_HOSTS = [
  "esm.sh",
  "cdn.jsdelivr.net",
  "fastly.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never touch Supabase traffic — let it hit the network (app queues offline).
  if (url.hostname.endsWith(".supabase.co") || url.hostname.endsWith(".supabase.in")) return;

  // App navigations: serve cached index.html when offline (SPA shell).
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const cdn = RUNTIME_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h));

  if (sameOrigin || cdn) {
    // cache-first
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(sameOrigin ? SHELL : RUNTIME).then((c) => c.put(req, copy));
          }
          return res;
        });
      })
    );
  }
});
