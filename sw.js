// Offline support: after the first visit the app keeps working without a network (photos never
// needed one). Network-first for everything this site serves, so an update is picked up on the
// next load and modules from two different releases are never mixed; the cache is the fallback.
// Google Fonts are cached on first use.
// Line art's models and runtimes (vendor/ort, vendor/mediapipe, vendor/models: ~54-66 MB with the
// silhouette's deeplab_v3 and magic_touch models) are
// never precached: a visitor who never opens Line art never downloads them. The first Line art use
// fetches them once; they go into their own cache, served cache-first (a file there never changes
// without a new name) and kept across releases, so an update does not download them again.
const CACHE = 'spiralist-2026-09-24c';
const MODELS = 'spiralist-models-v1';
const isModelFile = url => /\/vendor\/(ort|mediapipe|models)\//.test(url.pathname);
// every module the app imports (statically or on demand) and the film's desk photos, so the whole
// app, filming included, works offline after the first visit
const DESK_IDS = ['nero', 'calacatta', 'travertine', 'limewash', 'velvet', 'leather', 'sunlit', 'onyx'];
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest', './icon.svg', './vendor/mp4-muxer.mjs',
  './js/app.js', './js/brushes.js', './js/desks.js', './js/download.js', './js/encoder.js', './js/export.js', './js/film.js',
  './js/freeline.js', './js/history.js', './js/imageio.js', './js/materials.js', './js/maze.js', './js/papers.js',
  './js/renderer.js', './js/samples.js', './js/scene.js', './js/share.js', './js/shaders.js', './js/signature.js',
  './js/spiral.js', './js/store.js', './js/thumbs.js', './js/tone.js', './js/tools.js', './js/ui.js', './js/wetsim.js',
  './js/loupe.js', './js/real/index.js', './js/real/builder.js', './js/real/worker.js', './js/real/squiggle.js',
  './js/real/stipple.js', './js/real/scribble.js', './js/real/engrave.js',
  './js/lineart/index.js', './js/lineart/styles.js', './js/lineart/lines.js', './js/lineart/path.js',
  './js/lineart/strokes.js', './js/lineart/worker.js', './js/lineart/buildworker.js', './js/lineart/silhouette.js',
  './js/print3d/dialog.js', './js/print3d/presets.js', './js/print3d/worker.js', './js/print3d/products.js',
  './js/print3d/pkit.js', './js/print3d/mesh.js', './js/print3d/view.js', './vendor/earcut.mjs',
  './js/print3d/printfilm.js', './js/print3d/toolpath.js', './js/print3d/gcode.js', './js/print3d/toolpath.worker.js',
  ...DESK_IDS.map(id => `./img/desks/${id}.jpg`),
];

self.addEventListener('install', e => {
  // add files one by one: a single missing file must not stop the rest from being cached
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    // only our own old caches: other sites on the same origin (winchxyz.github.io) keep theirs
    .then(keys => Promise.all(keys.filter(k => k.startsWith('spiralist-') && k !== CACHE && k !== MODELS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !font) return;
  if (isModelFile(url)) {
    e.respondWith((async () => {
      const models = await caches.open(MODELS);
      const hit = await models.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      // whole files only (never a 206 range): the model loaders read them in one piece
      if (res && res.ok && res.status === 200) models.put(req, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (font) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
