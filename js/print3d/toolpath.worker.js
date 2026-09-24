// The print timelapse's slicer off the main thread: buildToolpath (./toolpath.js) in a module
// worker, so a phone does not freeze for the 5-25 s a lithophane takes to slice.
//   post { parts: [{ name, mesh: { positions, indices }, color }], opts }  (opts without functions)
//   <- { progress: 0..1 } ... then { tp } (typed arrays transferred) or { error }
import { buildToolpath } from './toolpath.js';

self.onmessage = async ev => {
  const { parts, opts } = ev.data || {};
  try {
    const tp = await buildToolpath(parts, { ...opts, onProgress: f => self.postMessage({ progress: f }) });
    const bufs = new Set();
    for (const o of [tp.beads, tp.track]) for (const v of Object.values(o)) if (ArrayBuffer.isView(v)) bufs.add(v.buffer);
    self.postMessage({ tp }, [...bufs]);
  } catch (e) {
    self.postMessage({ error: String(e && e.message || e) });
  }
};
