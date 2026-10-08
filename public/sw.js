// Minimal service worker: makes the app installable on phones and shows a friendly page offline.
// Everything else always comes fresh from the network (attendance must never be cached).
const OFFLINE = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><body style="font:16px system-ui;display:grid;place-items:center;min-height:90vh;margin:0;color:#334155"><div style="text-align:center;padding:24px"><h2>You are offline</h2><p>Connect to the internet to use Broadwing HR.</p><button onclick="location.reload()" style="font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#4f46e5;color:#fff">Try again</button></div>';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'content-type': 'text/html' } })));
});
