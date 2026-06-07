/**
 * samSegment.js — live "tap-anything" hold segmentation (in-browser MobileSAM).
 *
 * The HEAVY half (the image encoder) runs server-side once per wall
 * (scripts/encode_board_embedding.py) and stores a ~4 MB embedding ("fingerprint")
 * in Supabase storage. This module ships the LIGHT half: it lazy-loads the small
 * MobileSAM decoder (public/models/mobile_sam_decoder.onnx, ~16 MB, loaded once)
 * via onnxruntime-web (WASM — no WebGPU, so it works on iPhone Safari), fetches a
 * wall's embedding, and on a tap turns the point into a hold outline.
 *
 * Everything here works in the embedding's NATIVE image-pixel space and converts
 * the final outline to board-area % using the wall's boardRegion — so it's
 * resolution-independent (the displayed responsive image size is irrelevant).
 *
 * Public API:
 *   prewarm(info)                              -> warm decoder + this wall's embedding
 *   segmentAtBoardPct(cx, cy, boardRegion, info) -> polygon [[x%,y%],...] | null
 *   resetSam()                                 -> drop caches (e.g. on sign-out)
 *
 * `info` is the board_settings['sam_embedding_<id>'] blob:
 *   { url, shape:[1,256,64,64], dtype:'float32', orig_w, orig_h, ... }
 *
 * Validated in the spike: 24/24 Yonder holds (incl. 10/10 smallest) traced
 * tightly; ~1.4 s one-time load, ~130–250 ms per tap.
 */
import { simplifyPath } from '../utils/polygonUtils';

const DECODER_URL = '/models/mobile_sam_decoder.onnx';
const SAM_INPUT = 1024;            // ResizeLongestSide target (MobileSAM img_size)

// Reject masks that clearly aren't a single hold: a tap on bare plywood returns
// ~40–57% of the image; the biggest real Yonder hold was ~1.2%. 25% is a safe gap.
const MAX_AREA_FRAC = 0.25;
const MIN_AREA_PX = 30;            // smaller than the smallest foot chip = a miss

let ortPromise = null;
let sessionPromise = null;
const embCache = new Map();        // info.url -> { tensor, W, H }

// ─── lazy loaders (module singletons) ────────────────────────────────────────

async function getOrt() {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web').then((mod) => {
      const ort = mod.default || mod;
      // Self-host the wasm at /ort/ (copied from the npm package into public/ort/). ort
      // requests the UNHASHED filename, but Vite emits a HASHED asset, so ort's default
      // path 404s in a production build — wasmPaths pins it. Same-origin → offline-capable,
      // no CDN dependency (matters for flaky wifi at the board).
      ort.env.wasm.wasmPaths = '/ort/';
      ort.env.wasm.numThreads = 1;        // single-thread → no SharedArrayBuffer/COOP-COEP needed
      ort.env.wasm.simd = true;
      ort.env.wasm.proxy = false;
      return ort;
    });
  }
  return ortPromise;
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await getOrt();
      return ort.InferenceSession.create(DECODER_URL, { executionProviders: ['wasm'] });
    })();
  }
  return sessionPromise;
}

async function getEmbedding(info) {
  if (!info?.url) throw new Error('no embedding for this wall');
  if (embCache.has(info.url)) return embCache.get(info.url);
  const ort = await getOrt();
  const buf = await fetch(info.url).then((r) => {
    if (!r.ok) throw new Error(`embedding fetch ${r.status}`);
    return r.arrayBuffer();
  });
  const tensor = new ort.Tensor('float32', new Float32Array(buf), info.shape || [1, 256, 64, 64]);
  const rec = { tensor, W: info.orig_w, H: info.orig_h };
  embCache.set(info.url, rec);
  return rec;
}

/** Kick off decoder + embedding loads ahead of the first tap (call when the
 *  Tap tool is selected) so the first trace isn't slow. Safe to call repeatedly. */
export async function prewarm(info) {
  try { await Promise.all([getSession(), getEmbedding(info)]); } catch { /* surfaced on tap */ }
}

export function resetSam() { embCache.clear(); }

// ─── mask → polygon helpers (pure) ───────────────────────────────────────────

/** Flood the 4-connected foreground component containing (sx,sy). */
function floodComponent(mask, W, H, sx, sy) {
  const comp = new Uint8Array(W * H);
  const start = sy * W + sx;
  if (!mask[start]) return null;
  const stack = [start];
  comp[start] = 1;
  let area = 0;
  while (stack.length) {
    const i = stack.pop();
    area++;
    const x = i % W, y = (i / W) | 0;
    if (x > 0     && mask[i - 1] && !comp[i - 1]) { comp[i - 1] = 1; stack.push(i - 1); }
    if (x < W - 1 && mask[i + 1] && !comp[i + 1]) { comp[i + 1] = 1; stack.push(i + 1); }
    if (y > 0     && mask[i - W] && !comp[i - W]) { comp[i - W] = 1; stack.push(i - W); }
    if (y < H - 1 && mask[i + W] && !comp[i + W]) { comp[i + W] = 1; stack.push(i + W); }
  }
  return { comp, area };
}

/** If the tap pixel isn't on the mask, spiral out to the nearest foreground pixel. */
function findSeed(mask, W, H, px, py, radius = 14) {
  const cx = Math.round(px), cy = Math.round(py);
  if (cx >= 0 && cx < W && cy >= 0 && cy < H && mask[cy * W + cx]) return [cx, cy];
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < W && y >= 0 && y < H && mask[y * W + x]) return [x, y];
      }
    }
  }
  return null;
}

/** Moore-neighbour boundary trace (8-connected, clockwise) of a component mask. */
function traceBoundary(comp, W, H) {
  let sx = -1, sy = -1;
  for (let y = 0; y < H && sy < 0; y++) {
    for (let x = 0; x < W; x++) { if (comp[y * W + x]) { sx = x; sy = y; break; } }
  }
  if (sx < 0) return [];
  const N = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]; // CW from E
  const isF = (x, y) => x >= 0 && x < W && y >= 0 && y < H && comp[y * W + x];
  const boundary = [[sx, sy]];
  let px = sx, py = sy, bIdx = 4;          // entered start from the West
  const maxIter = 8 * (W + H) + (comp.length >> 4) + 1000;
  for (let it = 0; it < maxIter; it++) {
    let found = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (bIdx + k) % 8;
      if (isF(px + N[d][0], py + N[d][1])) { found = d; break; }
    }
    if (found < 0) break;                   // isolated pixel
    px += N[found][0]; py += N[found][1];
    bIdx = (found + 4) % 8;                  // we came from the opposite side
    if (px === sx && py === sy) break;
    boundary.push([px, py]);
  }
  return boundary;
}

// ─── main entry ──────────────────────────────────────────────────────────────

/**
 * Segment whatever is under a tap and return its outline in board-area %.
 * @param {number} cx tap x in board-% (0–100)
 * @param {number} cy tap y in board-% (0–100)
 * @param {{left,top,width,height}} R the wall's boardRegion (% of full image)
 * @param {object} info the sam_embedding pointer blob
 * @returns {Promise<Array<[number,number]>|null>} polygon in board-% or null (no hold under tap)
 */
export async function segmentAtBoardPct(cx, cy, R, info) {
  const ort = await getOrt();
  const [session, emb] = await Promise.all([getSession(), getEmbedding(info)]);
  const { W, H } = emb;

  // board-% → full-image px (inverse of the documented forward transform)
  const px = (W * (R.left + (cx / 100) * R.width)) / 100;
  const py = (H * (R.top + (cy / 100) * R.height)) / 100;
  const scale = SAM_INPUT / Math.max(W, H);

  const out = await session.run({
    image_embeddings: emb.tensor,
    point_coords: new ort.Tensor('float32', Float32Array.from([px * scale, py * scale, 0, 0]), [1, 2, 2]),
    point_labels: new ort.Tensor('float32', Float32Array.from([1, -1]), [1, 2]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]),
    orig_im_size: new ort.Tensor('float32', Float32Array.from([H, W]), [2]),
  });

  // threshold logits (> 0) → binary mask
  const logits = out.masks.data;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) if (logits[i] > 0) mask[i] = 1;

  const seed = findSeed(mask, W, H, px, py);
  if (!seed) return null;                              // nothing under the finger
  const blob = floodComponent(mask, W, H, seed[0], seed[1]);
  if (!blob || blob.area < MIN_AREA_PX) return null;
  if (blob.area > MAX_AREA_FRAC * W * H) return null;  // tapped bare plywood / background

  const ring = traceBoundary(blob.comp, W, H);
  if (ring.length < 3) return null;

  // boundary px → board-% (forward transform inverted), clamped to the board
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const pts = ring.map(([bx, by]) => [
    clamp((((bx / W) * 100) - R.left) * 100 / R.width),
    clamp((((by / H) * 100) - R.top) * 100 / R.height),
  ]);

  const simplified = simplifyPath(pts, 0.4);           // ~board-% units; matches Draw tool feel
  return simplified.length >= 3 ? simplified : null;
}
