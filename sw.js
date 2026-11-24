/* Service worker do SDE Contingência.
   - Guarda só os arquivos do app na instalação; nunca guarda respostas da rede durante o uso
     (evita que uma página de erro, manutenção ou login de Wi-Fi substitua o app).
   - Serve o app do cache primeiro: abre sem internet e não depende de servidor.
   - Versão nova só é aplicada quando o técnico toca em "Atualizar agora".
   Para publicar uma versão nova: altere VERSAO aqui e em app.js. */
const VERSAO = '1.2.2';
const CACHE = 'sde-contingencia-' + VERSAO;
const ARQUIVOS = ['./', 'index.html', 'styles.css', 'sde_forms.js', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS.map((u) => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('sde-contingencia-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'aplicar') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = (await c.match(r, { ignoreSearch: true })) || (r.mode === 'navigate' ? await c.match('index.html') : null);
    if (hit) return hit;
    try { return await fetch(r); } catch (err) { return new Response('Sem conexão', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  })());
});
