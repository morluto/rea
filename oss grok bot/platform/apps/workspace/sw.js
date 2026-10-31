const CACHE = 'bot-workshop-shell-v42';
const ASSETS = [
  '/',
  '/style.css',
  '/mascots.css',
  '/app.js',
  '/appearance.js',
  '/history-view.js',
  '/composer-drafts.js',
  '/remote.js',
  '/features.js',
  '/plugins.js',
  '/plugin-signin.js',
  '/workspace.js',
  '/mascots.js',
  '/icons.js',
  '/onboarding.js',
  '/transcript.js',
  '/markdown.js',
  '/vendor/marked.js',
  '/vendor/purify.js',
  '/artifacts.js',
  '/library.js',
  '/settings.js',
  '/account-menu.js',
  '/clipboard.js',
  '/computer.js',
  '/oauth.js',
  '/connected-actions.js',
  '/collaboration.js',
  '/devices.js',
  '/coding.js',
  '/learning.js',
  '/personal-vault.js',
  '/policies.js',
  '/library-search.js',
  '/voice.js',
  '/triggers.js',
  '/operations.js',
  '/marketplace.js',
  '/icon.svg',
  '/orbit-mark-dark.png',
  '/orbit-mark-light.png',
  '/manifest.webmanifest',
];
self.addEventListener('install', (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener('message', (event) => {
  if (event.data === 'ACTIVATE_UPDATE') self.skipWaiting();
});
self.addEventListener('push', (event) => {
  const data = event.data?.json?.() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Orbit', {
      body: data.body ?? 'Something needs your attention.',
      data: { url: data.url ?? '/' },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(clients.openWindow(url));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== location.origin ||
    url.search !== '' ||
    url.pathname.startsWith('/api/') ||
    !ASSETS.includes(url.pathname)
  )
    return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
