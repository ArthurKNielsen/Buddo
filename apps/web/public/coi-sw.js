// Makes the page "cross-origin isolated" so the CPU engine (wllama) can use every core instead of one.
// GitHub Pages can't send the COOP/COEP headers that unlock SharedArrayBuffer, so this service worker adds
// them to Buddo's own pages and worker scripts. Everything else (model downloads, /api streams) passes through untouched.
// COEP "credentialless" keeps Google Fonts and images from other sites working.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.mode !== 'navigate' && req.destination !== 'worker' && req.destination !== 'sharedworker') return;
  e.respondWith(
    fetch(req).then((res) => {
      if (!res || res.status === 0) return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }),
  );
});
