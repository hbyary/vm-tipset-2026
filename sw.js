const CACHE = "vm-tipset-2026-v19";
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Allow the page to force an immediate update.
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never intercept cross-origin (ESPN, etc.) — let the browser handle it.
  if (url.origin !== self.location.origin) return;

  const isImage = /\.(png|jpe?g|svg|webp|ico|gif)$/i.test(url.pathname);

  if (isImage) {
    // Cache-first for immutable images/icons.
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((resp) => {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return resp;
          }),
      ),
    );
    return;
  }

  // Network-first for the app shell (HTML/JS/CSS) AND data (JSON).
  // Guarantees the latest code and latest results whenever online; cache is
  // only a fallback for offline use.
  e.respondWith(
    fetch(req)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return resp;
      })
      .catch(() =>
        caches
          .match(req)
          .then((hit) => hit || caches.match("index.html") || caches.match("./")),
      ),
  );
});
