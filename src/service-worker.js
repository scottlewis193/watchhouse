import { build, files, version } from '$service-worker';

const worker = /** @type {ServiceWorkerGlobalScope} */ (self);
const cacheName = `watchhouse-${version}`;
const appFiles = [...build, ...files];
const shellFiles = [...appFiles, '/library', '/downloads'];

worker.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(cacheName)
      .then((cache) => cache.addAll(shellFiles))
      .then(() => worker.skipWaiting())
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key))))
      .then(() => worker.clients.claim())
  );
});

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== worker.location.origin || url.pathname.startsWith('/api/')) return;

  if (appFiles.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
  }
});

async function networkFirstPage(request) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || (await cache.match(new URL(request.url).pathname)) || (await cache.match('/offline.html'));
  }
}
