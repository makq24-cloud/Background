export function colorDistance(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * In-place color-to-alpha. Mutates `data` (which is the RGBA byte array of
 * an ImageData). Used by the worker so it can run without allocating a new
 * output buffer alongside the input — caller pre-copies source bytes into
 * the destination buffer, this then transforms them.
 *
 * The behaviour matches applyTrueColorToAlpha exactly; that function is a
 * thin wrapper that allocates the result for non-worker callers.
 */
export function applyTrueColorToAlphaInPlace(
  data: Uint8ClampedArray,
  targetR: number,
  targetG: number,
  targetB: number,
  threshold: number,
  softness: number,
): void {
  const forceDist = (threshold / 100) * 100;
  const featherWidth = (softness / 100) * 200;
  const forceDistSq = forceDist * forceDist;
  const fadeEnd = forceDist + featherWidth;
  const fadeEndSq = fadeEnd * fadeEnd;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];

    if (a === 0) continue;

    const dr = r - targetR;
    const dg = g - targetG;
    const db = b - targetB;
    const dsq = dr * dr + dg * dg + db * db;

    let alphaFrac: number;
    if (dsq <= forceDistSq) {
      alphaFrac = 0;
    } else if (featherWidth === 0 || dsq >= fadeEndSq) {
      alphaFrac = 1;
    } else {
      const d = Math.sqrt(dsq);
      const t = (d - forceDist) / featherWidth;
      alphaFrac = t * t * (3 - 2 * t);
    }

    if (alphaFrac <= 0) {
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
      continue;
    }

    const finalAlpha = Math.round(alphaFrac * a);

    if (alphaFrac >= 1) {
      data[i + 3] = finalAlpha;
      continue;
    }

    const inv = 1 - alphaFrac;
    data[i]     = clampByte((r - targetR * inv) / alphaFrac);
    data[i + 1] = clampByte((g - targetG * inv) / alphaFrac);
    data[i + 2] = clampByte((b - targetB * inv) / alphaFrac);
    data[i + 3] = finalAlpha;
  }
}

/**
 * Color-to-alpha with bounded effect — solid bg removal, smooth edge feather.
 *
 * Behaviour by zone (RGB-distance from target):
 *   d ≤ threshold              → alpha = 0  (clean transparent)
 *   threshold < d < threshold+softness → smoothstep fade from 0 → 1
 *   d ≥ threshold + softness   → alpha = 1  (untouched, fully opaque)
 *
 * Within the feather zone we apply the GIMP unmix math to recover the
 * underlying foreground colour, so edge pixels lose the bg tint cleanly
 * rather than just becoming semi-transparent versions of the mixed pixel.
 *
 * This is intentionally NOT pure c2a-everywhere — the previous version
 * made every dark pixel proportionally transparent which collapsed dark
 * figure parts (hair, eyes, dark clothing) into the background.
 *
 * threshold (0-100): mapped to 0-100 RGB distance.
 * softness   (0-100): mapped to 0-100 RGB distance feather width.
 */
export function applyTrueColorToAlpha(
  imageData: ImageData,
  targetR: number,
  targetG: number,
  targetB: number,
  threshold: number,
  softness: number,
): ImageData {
  const result = new ImageData(imageData.width, imageData.height);
  result.data.set(imageData.data);
  applyTrueColorToAlphaInPlace(result.data, targetR, targetG, targetB, threshold, softness);
  return result;
}

/**
 * True color-to-alpha — the GIMP / Photopea algorithm.
 *
 * Unlike the bounded version above (which keeps interiors fully opaque and
 * only feathers a narrow edge band), this is GLOBAL: every pixel's opacity
 * becomes a function of how far its colour sits from the target. Pixels at
 * the target colour go fully transparent; pixels far from it stay solid;
 * everything between gets graduated partial alpha. Each pixel's colour is
 * then decontaminated (the target colour is unmixed back out), so there is
 * no grey/dark matte fringe left ringing the artwork.
 *
 * threshold (0-100): a small inner zone forced fully transparent, for when
 *                    the background isn't perfectly uniform. 0 = pure C2A.
 */
export function applyColorToAlphaInPlace(
  data: Uint8ClampedArray,
  tR: number, tG: number, tB: number,
  transparency: number, // 0-100: coverage at/below which a pixel goes fully clear
  opacity: number,      // 0-100: coverage at/above which a pixel stays fully solid
): void {
  const tT = transparency / 100;
  const oT = opacity / 100;
  // Width of the graded zone. Guarded so opacity <= transparency degrades to
  // a near-hard cutoff instead of dividing by zero.
  const den = Math.max(oT - tT, 0.001);
  for (let i = 0; i < data.length; i += 4) {
    const a0 = data[i + 3];
    if (a0 === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const dr = r - tR, dg = g - tG, db = b - tB;
    // Per-channel coverage: how far each channel sits from the target,
    // normalised by the room available toward white (or black).
    const ar = dr > 0 ? dr / (255 - tR) : dr < 0 ? -dr / tR : 0;
    const ag = dg > 0 ? dg / (255 - tG) : dg < 0 ? -dg / tG : 0;
    const ab = db > 0 ? db / (255 - tB) : db < 0 ? -db / tB : 0;
    const cov = ar > ag ? (ar > ab ? ar : ab) : (ag > ab ? ag : ab);

    // GIMP/Photopea two-threshold remap: below the transparency threshold
    // -> fully clear; above the opacity threshold -> fully solid; graded
    // between. This is what stops solid artwork from washing out.
    let alpha = (cov - tT) / den;
    if (alpha <= 0) {
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
      continue;
    }
    if (alpha > 1) alpha = 1;
    // Decontaminate (unmix the target colour back out). At alpha === 1 this
    // returns the pixel exactly unchanged, so solid artwork is left intact.
    data[i]     = clampByte(tR + dr / alpha);
    data[i + 1] = clampByte(tG + dg / alpha);
    data[i + 2] = clampByte(tB + db / alpha);
    data[i + 3] = Math.round(alpha * a0);
  }
}

export function applyColorToAlpha(
  imageData: ImageData, tR: number, tG: number, tB: number,
  transparency: number, opacity: number,
): ImageData {
  const result = new ImageData(imageData.width, imageData.height);
  result.data.set(imageData.data);
  applyColorToAlphaInPlace(result.data, tR, tG, tB, transparency, opacity);
  return result;
}

export function downscalePreview(
  imageData: ImageData,
  maxSize: number = 500
): ImageData {
  if (imageData.width <= maxSize && imageData.height <= maxSize) {
    return imageData;
  }

  const scale = Math.min(maxSize / imageData.width, maxSize / imageData.height);
  const newWidth = Math.round(imageData.width * scale);
  const newHeight = Math.round(imageData.height * scale);

  const srcData = imageData.data;
  const result = new ImageData(newWidth, newHeight);
  const dstData = result.data;

  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const srcX = Math.floor(x / scale);
      const srcY = Math.floor(y / scale);
      const srcIdx = (srcY * imageData.width + srcX) * 4;
      const dstIdx = (y * newWidth + x) * 4;

      dstData[dstIdx] = srcData[srcIdx];
      dstData[dstIdx + 1] = srcData[srcIdx + 1];
      dstData[dstIdx + 2] = srcData[srcIdx + 2];
      dstData[dstIdx + 3] = srcData[srcIdx + 3];
    }
  }

  return result;
}

export function getPixelTransparency(imageData: ImageData, x: number, y: number): number {
  if (x < 0 || x >= imageData.width || y < 0 || y >= imageData.height) {
    return 0;
  }
  const idx = (y * imageData.width + x) * 4;
  return imageData.data[idx + 3];
}

/**
 * Connectivity-aware color-to-alpha. The recommended "Smart" mode.
 *
 * The classic algorithm above treats every pixel independently — so black in
 * a figure's hair gets the same semi-transparency as black in a background
 * halftone dot. This version groups matching pixels into connected regions
 * and only removes pixels whose region IS BACKGROUND. Specifically a region
 * is removed when:
 *   - it touches the canvas edge (definitionally background), OR
 *   - it is smaller than `protectThreshold` pixels (specks/artifacts).
 *
 * Large isolated regions (figure features like hair, ink areas, fine lines)
 * stay fully opaque.
 *
 * Already-transparent pixels (alpha === 0) are treated as part of the match
 * region for connectivity purposes — so flood fill propagates through them.
 * This makes the algorithm work on images that have ALREADY had partial
 * background removal (e.g. a milk-poster design): edge-touching black
 * halftones inside the previously-cut-out area still get reached.
 *
 * Within removed regions, partial alpha is computed by color distance and
 * colour is decontaminated using the same GIMP unmix math, so pixels that
 * are genuinely a blend of design + background recover their true design
 * colour rather than getting desaturated.
 *
 * sensitivity (0-100): inner colour-distance threshold for full removal.
 * softness    (0-100): width of the partial-alpha feather zone.
 * protect     (0-100): minimum isolated-region size to PRESERVE (kept
 *   opaque). Quadratic scale relative to canvas area: 0 protects nothing
 *   (matches classic behaviour); 100 protects almost any isolated region.
 *   At 50 (default), components ≥ ~0.25% of the canvas are kept.
 */
export function applyConnectedColorToAlpha(
  imageData: ImageData,
  targetR: number,
  targetG: number,
  targetB: number,
  sensitivity: number,
  softness: number,
  protect: number
): ImageData {
  const w = imageData.width;
  const h = imageData.height;
  const N = w * h;
  const src = imageData.data;

  const maxDist = Math.sqrt(3 * 255 * 255);
  const threshLow = (sensitivity / 100) * maxDist;
  const threshHigh = threshLow + (softness / 100) * maxDist;
  const threshLowSq = threshLow * threshLow;
  const threshHighSq = threshHigh * threshHigh;

  // Quadratic scaling so the low end of the slider gives speck-level
  // granularity while the high end can keep big features.
  const protectThreshold = Math.max(
    0,
    Math.round(Math.pow(protect / 100, 2) * (N * 0.01))
  );

  // Phase 1: classify pixels. inMatch[p] == 1 iff this pixel is either
  // already transparent OR within the high-threshold colour distance of
  // the target. These are the pixels that flood-fill traverses.
  const inMatch = new Uint8Array(N);
  for (let i = 0, p = 0; p < N; i += 4, p++) {
    const a = src[i + 3];
    if (a === 0) { inMatch[p] = 1; continue; }
    const dr = src[i] - targetR;
    const dg = src[i + 1] - targetG;
    const db = src[i + 2] - targetB;
    const dsq = dr * dr + dg * dg + db * db;
    if (dsq <= threshHighSq) inMatch[p] = 1;
  }

  // Phase 2: connected-component labelling via iterative BFS. labels[p]
  // holds component id (1-based). Component metadata is tracked in
  // parallel arrays for size and edge-touching.
  const labels = new Int32Array(N);
  const queue = new Int32Array(N);
  // Component data — index 0 reserved/unused for "no component".
  const compSize: number[] = [0];
  const compEdge: boolean[] = [false];
  let nextLabel = 1;

  for (let start = 0; start < N; start++) {
    if (!inMatch[start] || labels[start] !== 0) continue;

    const label = nextLabel++;
    let head = 0, tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    let size = 0;
    let touchesEdge = false;

    while (head < tail) {
      const idx = queue[head++];
      size++;
      const x = idx % w;
      const y = (idx - x) / w;
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1) touchesEdge = true;

      // 4-neighbour expansion — diagonal omitted intentionally so thin
      // diagonal links between separate halftone dots don't merge.
      if (x > 0) {
        const n = idx - 1;
        if (inMatch[n] && labels[n] === 0) { labels[n] = label; queue[tail++] = n; }
      }
      if (x < w - 1) {
        const n = idx + 1;
        if (inMatch[n] && labels[n] === 0) { labels[n] = label; queue[tail++] = n; }
      }
      if (y > 0) {
        const n = idx - w;
        if (inMatch[n] && labels[n] === 0) { labels[n] = label; queue[tail++] = n; }
      }
      if (y < h - 1) {
        const n = idx + w;
        if (inMatch[n] && labels[n] === 0) { labels[n] = label; queue[tail++] = n; }
      }
    }

    compSize.push(size);
    compEdge.push(touchesEdge);
  }

  // Phase 3: decide which components get removed. Touching the edge wins
  // over the size protection — a huge background bg is removed regardless
  // of how big it is, as it's by definition background.
  const removeComp = new Uint8Array(nextLabel);
  for (let c = 1; c < nextLabel; c++) {
    if (compEdge[c] || compSize[c] <= protectThreshold) removeComp[c] = 1;
  }

  // Phase 4: produce output. Pixels in removed components get alpha by
  // colour distance + decontamination. Everything else passes through.
  const result = new ImageData(w, h);
  const dst = result.data;

  for (let i = 0, p = 0; p < N; i += 4, p++) {
    const r = src[i], g = src[i + 1], b = src[i + 2], a = src[i + 3];
    dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = a;

    if (a === 0) continue;
    const lbl = labels[p];
    if (lbl === 0 || removeComp[lbl] === 0) continue;

    const dr = r - targetR;
    const dg = g - targetG;
    const db = b - targetB;
    const dsq = dr * dr + dg * dg + db * db;

    let alphaFrac: number;
    if (dsq <= threshLowSq) {
      alphaFrac = 0;
    } else if (dsq >= threshHighSq) {
      alphaFrac = 1;
    } else {
      const dist = Math.sqrt(dsq);
      alphaFrac = (dist - threshLow) / (threshHigh - threshLow);
    }

    if (alphaFrac <= 0) {
      dst[i] = 0; dst[i + 1] = 0; dst[i + 2] = 0; dst[i + 3] = 0;
      continue;
    }
    if (alphaFrac >= 1) continue; // keep source pixel unchanged

    // Decontaminate: extract the foreground colour from the mixed pixel.
    const finalAlpha = Math.round(alphaFrac * a);
    const inv = 1 - alphaFrac;
    let nr = (r - targetR * inv) / alphaFrac;
    let ng = (g - targetG * inv) / alphaFrac;
    let nb = (b - targetB * inv) / alphaFrac;
    if (nr < 0) nr = 0; else if (nr > 255) nr = 255;
    if (ng < 0) ng = 0; else if (ng > 255) ng = 255;
    if (nb < 0) nb = 0; else if (nb > 255) nb = 255;
    dst[i] = Math.round(nr);
    dst[i + 1] = Math.round(ng);
    dst[i + 2] = Math.round(nb);
    dst[i + 3] = finalAlpha;
  }

  return result;
}


/**
 * Finds the dominant near-black or near-white color in a set of sampled
 * pixels, bucketed for tolerance. Returns null if no samples qualify.
 *
 * `shouldSample(i)` decides which pixel indices (i = byte offset, multiple
 * of 4) to consider. This lets callers restrict to borders, full image,
 * stride sampling, etc., without duplicating the histogram code.
 */
function dominantShadeIn(
  data: Uint8ClampedArray,
  mode: 'dark' | 'light',
  shouldSample: (pixelIndex: number) => boolean,
): { color: [number, number, number]; sampleCount: number } | null {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  const bucketSize = 8;
  let samples = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (!shouldSample(i)) continue;
    const a = data[i + 3];
    if (a < 128) continue;

    const r = data[i], g = data[i + 1], b = data[i + 2];
    const brightness = 0.299 * r + 0.587 * g + 0.114 * b;

    if (mode === 'dark' && brightness > 80) continue;
    if (mode === 'light' && brightness < 180) continue;

    const br = Math.round(r / bucketSize) * bucketSize;
    const bg = Math.round(g / bucketSize) * bucketSize;
    const bb = Math.round(b / bucketSize) * bucketSize;
    // Pack RGB into a single int key — much faster than string concat in a
    // tight loop, and the buckets are coarse enough that 16 bits per channel
    // is overkill.
    const key = (br << 16) | (bg << 8) | bb;

    const existing = buckets.get(key);
    if (existing) {
      existing.count++;
    } else {
      buckets.set(key, { count: 1, r: br, g: bg, b: bb });
    }
    samples++;
  }

  if (buckets.size === 0) return null;

  let best = { count: 0, r: 0, g: 0, b: 0 };
  for (const entry of buckets.values()) {
    if (entry.count > best.count) best = entry;
  }

  return { color: [best.r, best.g, best.b], sampleCount: samples };
}

/**
 * Detects the dominant near-black or near-white color, prioritising the
 * image border — that's where the shirt / background usually lives. For a
 * centered graphic this avoids being fooled by large dark or light areas
 * inside the design.
 *
 * Strategy:
 *   1. Sample a border strip (5% of the shorter dimension, clamped to a
 *      reasonable range). Use that result if it has enough samples to be
 *      trustworthy.
 *   2. Otherwise fall back to a full scan — preserves prior behaviour for
 *      edge-bleeding designs that fill the canvas.
 *
 * Returns null if no qualifying pixels are found anywhere.
 */
export function detectDominantShade(
  imageData: ImageData,
  mode: 'dark' | 'light',
): [number, number, number] | null {
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  const minSamples = 200;

  // Border width: ~5% of the shorter dimension, clamped 8..200.
  const border = Math.max(8, Math.min(200, Math.round(Math.min(w, h) * 0.05)));

  const borderPick = dominantShadeIn(data, mode, (i) => {
    const px = (i / 4) | 0;
    const y = (px / w) | 0;
    const x = px - y * w;
    return x < border || x >= w - border || y < border || y >= h - border;
  });

  if (borderPick && borderPick.sampleCount >= minSamples) {
    return borderPick.color;
  }

  // Fallback: full-image scan. Same behaviour as the old function.
  const fullPick = dominantShadeIn(data, mode, () => true);
  if (fullPick) return fullPick.color;

  // Last resort: return whatever the border found, even if sparse.
  return borderPick ? borderPick.color : null;
}
// Decides whether the image's background is light or dark by sampling the
// border ring. Used to pick the right auto-detect mode on entry instead of
// always assuming a dark background.
export function detectBackgroundShade(img: ImageData): 'dark' | 'light' {
  const { width: w, height: h, data } = img;
  const border = Math.max(4, Math.round(Math.min(w, h) * 0.04));
  let sum = 0;
  let count = 0;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < border || y >= h - border;
    for (let x = 0; x < w; x++) {
      if (!edgeRow && x >= border && x < w - border) { x = w - border - 1; continue; }
      const i = (y * w + x) * 4;
      if (data[i + 3] < 128) continue; // ignore already-transparent pixels
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      count++;
    }
  }
  if (count === 0) return 'dark';
  return sum / count > 128 ? 'light' : 'dark';
}
