// Floyd–Steinberg dithered colour quantization that preserves RGBA.
//
// upng-js's plain quantization (the "Compressed" export mode) snaps every
// pixel to the nearest of N palette colours with no spatial dithering — so a
// smooth gradient collapses into flat bands. On painted/photographic content
// (faces, soft shading) that shows up as blotchy, posterized skin.
//
// This module instead diffuses each pixel's rounding error into its
// neighbours (Floyd–Steinberg, serpentine scan). A gradient becomes fine
// grain rather than hard steps, so it stays acceptable for print while the
// file still benefits from being a compact indexed PNG.
//
// Pipeline:
//   1. upng-js builds a good 255-colour RGBA palette (median cut).
//   2. We re-render the ORIGINAL image against that palette with
//      Floyd–Steinberg error diffusion, working in PREMULTIPLIED-alpha space
//      so every transparent pixel collapses to (0,0,0,0) and cannot drift
//      onto a faintly-visible palette entry.
//   3. The dithered image has <=255 unique colours, so upng-js's ps=0
//      encoder writes it as an EXACT indexed PNG (PLTE + tRNS) — no second
//      quantization pass, the dither survives intact.
//
// Pure module: no DOM, so it runs identically in the browser and in tests.

import UPNG from 'upng-js';

// We ask upng-js for 255 (not 256) palette colours. Its ps=0 encoder seeds
// its own palette with one entry (transparent black) before scanning unique
// colours; capping our palette at 255 guarantees the total stays <=256 and
// the output is therefore always an indexed PNG, even for fully-opaque art.
const PALETTE_SIZE = 255;

// Nearest-palette lookup cache resolution: 6 bits R/G/B, 4 bits A. Colours
// inside the same small cube share a palette pick (visually irrelevant — the
// error is still computed from the exact pixel value), turning millions of
// 255-entry scans into mostly O(1) hits.
const RGB_BITS = 6;
const A_BITS = 4;

// Yield to the event loop every this many scanlines so a progress bar can
// paint and the tab stays responsive on large exports.
const ROW_BLOCK = 48;

export type DitherResult = {
  /** Encoded PNG bytes. */
  buffer: ArrayBuffer;
  /** Distinct colours actually used by the dithered image. */
  coloursUsed: number;
};

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Encode an RGBA image as a Floyd–Steinberg dithered, palette-quantized PNG.
 *
 * @param data       RGBA pixel bytes, length = width * height * 4.
 * @param width      Image width in pixels.
 * @param height     Image height in pixels.
 * @param onProgress Optional 0..1 progress callback (fires per row block).
 */
export async function encodeDitheredPNG(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  onProgress?: (frac: number) => void,
): Promise<DitherResult> {
  const px = width * height;
  if (data.length < px * 4) {
    throw new Error('ditherQuantize: pixel buffer too small for dimensions');
  }

  // --- 1. Palette from upng-js (median cut in RGBA space) -----------------
  // Copy into a fresh, offset-free buffer so upng-js gets exactly what it
  // expects regardless of how `data` was sliced.
  const srcCopy = new Uint8Array(px * 4);
  srcCopy.set(data.subarray(0, px * 4));
  const q = UPNG.quantize([srcCopy.buffer], PALETTE_SIZE, false);
  const leaves = q.plte;
  const pn = leaves.length;

  // Two views of each palette entry:
  //   straight*  — the real RGBA colour, written to the output PNG.
  //   premult*   — RGB scaled by alpha, used only for nearest-colour search
  //                and error diffusion (so transparency behaves correctly).
  const sr = new Int32Array(pn);
  const sg = new Int32Array(pn);
  const sb = new Int32Array(pn);
  const sa = new Int32Array(pn);
  const mr = new Float32Array(pn);
  const mg = new Float32Array(pn);
  const mb = new Float32Array(pn);
  const ma = new Float32Array(pn);
  for (let i = 0; i < pn; i++) {
    const c = leaves[i].est.rgba >>> 0;
    const r = c & 255;
    const g = (c >>> 8) & 255;
    const b = (c >>> 16) & 255;
    const a = (c >>> 24) & 255;
    sr[i] = r; sg[i] = g; sb[i] = b; sa[i] = a;
    const af = a / 255;
    mr[i] = r * af; mg[i] = g * af; mb[i] = b * af; ma[i] = a;
  }

  // --- 2. Nearest-palette lookup (premultiplied) with a coarse LUT cache --
  const cache = new Int16Array(1 << (RGB_BITS * 3 + A_BITS)).fill(-1);
  const rgbShift = 8 - RGB_BITS;
  const aShift = 8 - A_BITS;

  // r,g,b,a here are premultiplied channel values, each already in 0..255.
  const nearest = (r: number, g: number, b: number, a: number): number => {
    const key =
      ((r >> rgbShift) << (RGB_BITS * 2 + A_BITS)) |
      ((g >> rgbShift) << (RGB_BITS + A_BITS)) |
      ((b >> rgbShift) << A_BITS) |
      (a >> aShift);
    const hit = cache[key];
    if (hit >= 0) return hit;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pn; i++) {
      const dr = r - mr[i];
      const dg = g - mg[i];
      const db = b - mb[i];
      const da = a - ma[i];
      const d = dr * dr + dg * dg + db * db + da * da;
      if (d < bestD) {
        bestD = d;
        best = i;
        if (d === 0) break;
      }
    }
    cache[key] = best;
    return best;
  };

  // --- 3. Floyd–Steinberg error diffusion, serpentine scan ----------------
  // Error is carried in two float scanlines (current row + next row), four
  // premultiplied channels per pixel. Serpentine scanning (alternating
  // L->R / R->L) avoids the directional "worm" artifacts a one-way scan can
  // leave on smooth gradients.
  const out = new Uint8Array(px * 4);
  const rowLen = width * 4;
  let errCur = new Float32Array(rowLen);
  let errNext = new Float32Array(rowLen);

  for (let y = 0; y < height; y++) {
    const ltr = (y & 1) === 0;
    errNext.fill(0);

    const xStart = ltr ? 0 : width - 1;
    const xEnd = ltr ? width : -1;
    const xStep = ltr ? 1 : -1;

    for (let x = xStart; x !== xEnd; x += xStep) {
      const i = (y * width + x) * 4;
      const e = x * 4;

      // Premultiply the source pixel, then add the accumulated error.
      const a0 = data[i + 3];
      const af = a0 / 255;
      const tr = data[i] * af + errCur[e];
      const tg = data[i + 1] * af + errCur[e + 1];
      const tb = data[i + 2] * af + errCur[e + 2];
      const ta = a0 + errCur[e + 3];

      const p = nearest(
        clamp255(tr) | 0,
        clamp255(tg) | 0,
        clamp255(tb) | 0,
        clamp255(ta) | 0,
      );

      // Write the straight (non-premultiplied) palette colour to the output.
      out[i] = sr[p];
      out[i + 1] = sg[p];
      out[i + 2] = sb[p];
      out[i + 3] = sa[p];

      // Diffuse the unclamped premultiplied error so total energy is
      // conserved (FS kernel: 7/16 ahead, then 3/16 - 5/16 - 1/16 below).
      const dr = tr - mr[p];
      const dg = tg - mg[p];
      const db = tb - mb[p];
      const da = ta - ma[p];

      const xAhead = x + xStep;
      const xBehind = x - xStep;
      const aheadOk = xAhead >= 0 && xAhead < width;
      const behindOk = xBehind >= 0 && xBehind < width;

      if (aheadOk) {
        const ea = xAhead * 4;
        errCur[ea] += dr * (7 / 16);
        errCur[ea + 1] += dg * (7 / 16);
        errCur[ea + 2] += db * (7 / 16);
        errCur[ea + 3] += da * (7 / 16);
      }
      errNext[e] += dr * (5 / 16);
      errNext[e + 1] += dg * (5 / 16);
      errNext[e + 2] += db * (5 / 16);
      errNext[e + 3] += da * (5 / 16);
      if (behindOk) {
        const eb = xBehind * 4;
        errNext[eb] += dr * (3 / 16);
        errNext[eb + 1] += dg * (3 / 16);
        errNext[eb + 2] += db * (3 / 16);
        errNext[eb + 3] += da * (3 / 16);
      }
      if (aheadOk) {
        const ea = xAhead * 4;
        errNext[ea] += dr * (1 / 16);
        errNext[ea + 1] += dg * (1 / 16);
        errNext[ea + 2] += db * (1 / 16);
        errNext[ea + 3] += da * (1 / 16);
      }
    }

    // Next row's diffused error becomes the current row.
    const tmp = errCur;
    errCur = errNext;
    errNext = tmp;

    if (onProgress && (y % ROW_BLOCK === 0 || y === height - 1)) {
      onProgress((y + 1) / height);
      // Yield so the UI can repaint between row blocks.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // --- 4. Encode as an exact indexed PNG ----------------------------------
  // ps=0 makes upng-js detect the <=256 unique colours and emit a verbatim
  // indexed PNG — no further quantization, so the dither is preserved.
  const png = UPNG.encode([out.buffer], width, height, 0);

  const seen = new Set<number>();
  const out32 = new Uint32Array(out.buffer);
  for (let i = 0; i < out32.length; i++) seen.add(out32[i]);

  return { buffer: png, coloursUsed: seen.size };
}
