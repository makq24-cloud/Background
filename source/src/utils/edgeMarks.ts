/**
 * Edge mark detection.
 *
 * Finds the thin accidental lines that sometimes survive along the very edge
 * of a graphic — a stray 1-3px border left behind by an editor, an upscaler,
 * or the source scan. They are nearly invisible on screen (a 2px line on a
 * phone preview is sub-pixel) but print as a hard, obvious line on fabric.
 *
 * The hard part is NOT finding thin lines. It is not flagging artwork that
 * runs off the edge on purpose. The discriminator is ISOLATION: a deliberate
 * bleed is continuous with the body of the design, while an accidental mark
 * is a floating strip with a gap of nothing between it and the real artwork.
 *
 * Nothing here mutates the image; `removeMarks` returns a new ImageData.
 */

/** Alpha at/below which a pixel is treated as empty. Matches MIN_ALPHA. */
const EMPTY_ALPHA = 8;

/** How far in from each edge we look, as a fraction of the short dimension. */
const BAND_FRAC = 0.012;
/** Absolute clamps on that band, in pixels. */
const BAND_MIN = 10;
const BAND_MAX = 90;

/** A mark may be at most this thick (px) measured inward from the edge. */
const MAX_THICK = 6;
/** A run must be at least this long (px) along the edge to count. */
const MIN_RUN = 40;
/**
 * Clear space required between the mark and the nearest real artwork, in px.
 * Below this we assume the mark is part of the design bleeding off the edge.
 */
const MIN_GAP = 10;
/**
 * A run is allowed to have gaps this small without being split in two —
 * accidental lines are often broken by anti-aliasing.
 */
const BRIDGE = 12;

export type EdgeSide = 'top' | 'bottom' | 'left' | 'right';

export type EdgeMark = {
  id: number;
  side: EdgeSide;
  /** Start position along the edge, in image px. */
  start: number;
  /** Length along the edge, in image px. */
  length: number;
  /** Thickness measured inward from the edge, in image px. */
  thickness: number;
  /** Clear px between this mark and the nearest artwork, inward. */
  gap: number;
  /** Mean alpha of the mark's pixels (0-255). */
  meanAlpha: number;
};

export type EdgeScan = {
  marks: EdgeMark[];
  width: number;
  height: number;
};

/** Alpha at (x,y). */
function alphaAt(d: Uint8ClampedArray, w: number, x: number, y: number): number {
  return d[(y * w + x) * 4 + 3];
}

/**
 * For one edge, walk every position along it and measure how deep the ink
 * runs inward. Returns, per position: thickness of the edge-hugging ink
 * (0 if the edge pixel itself is empty), and the gap of empty pixels that
 * follows it before any further ink.
 */
function profileEdge(
  data: Uint8ClampedArray, w: number, h: number, side: EdgeSide, band: number,
): { thick: Int32Array; gap: Int32Array; alpha: Int32Array } {
  const along = (side === 'top' || side === 'bottom') ? w : h;
  const thick = new Int32Array(along);
  const gap = new Int32Array(along);
  const alpha = new Int32Array(along);

  for (let p = 0; p < along; p++) {
    let run = 0;
    let sum = 0;
    // Walk inward from the edge while ink continues.
    for (let d = 0; d < band; d++) {
      let x: number, y: number;
      if (side === 'top')         { x = p; y = d; }
      else if (side === 'bottom') { x = p; y = h - 1 - d; }
      else if (side === 'left')   { x = d; y = p; }
      else                        { x = w - 1 - d; y = p; }
      const a = alphaAt(data, w, x, y);
      if (a <= EMPTY_ALPHA) break;
      run++; sum += a;
    }
    thick[p] = run;
    alpha[p] = run ? Math.round(sum / run) : 0;

    // Then measure the clear gap that follows, before the next ink.
    let g = 0;
    if (run > 0) {
      for (let d = run; d < band; d++) {
        let x: number, y: number;
        if (side === 'top')         { x = p; y = d; }
        else if (side === 'bottom') { x = p; y = h - 1 - d; }
        else if (side === 'left')   { x = d; y = p; }
        else                        { x = w - 1 - d; y = p; }
        if (alphaAt(data, w, x, y) > EMPTY_ALPHA) break;
        g++;
      }
    }
    gap[p] = g;
  }
  return { thick, gap, alpha };
}

/**
 * Scan all four edges. A position is "mark-like" when it has ink hugging the
 * edge, that ink is thin, and there is clear space behind it. Contiguous
 * mark-like positions (bridging small breaks) become one mark.
 */
export function findEdgeMarks(img: ImageData): EdgeScan {
  const { width: w, height: h, data } = img;
  const band = Math.max(BAND_MIN, Math.min(BAND_MAX, Math.round(Math.min(w, h) * BAND_FRAC)));
  const marks: EdgeMark[] = [];
  let id = 1;

  for (const side of ['top', 'bottom', 'left', 'right'] as EdgeSide[]) {
    const { thick, gap, alpha } = profileEdge(data, w, h, side, band);
    const n = thick.length;
    const isMark = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      // Thin ink on the edge, with real clear space behind it. A gap that
      // runs to the end of the band counts — nothing found means nothing near.
      if (thick[p] > 0 && thick[p] <= MAX_THICK &&
          (gap[p] >= MIN_GAP || thick[p] + gap[p] >= band)) {
        isMark[p] = 1;
      }
    }

    let p = 0;
    while (p < n) {
      if (!isMark[p]) { p++; continue; }
      let q = p;
      let lastHit = p;
      while (q < n) {
        if (isMark[q]) { lastHit = q; q++; continue; }
        // Allow a short break before giving up on the run.
        let probe = q;
        while (probe < n && probe - lastHit <= BRIDGE && !isMark[probe]) probe++;
        if (probe < n && probe - lastHit <= BRIDGE && isMark[probe]) { q = probe; continue; }
        break;
      }
      const start = p;
      const length = lastHit - p + 1;
      if (length >= MIN_RUN) {
        let tMax = 0, aSum = 0, aN = 0, gMin = Infinity;
        for (let k = start; k <= lastHit; k++) {
          if (!isMark[k]) continue;
          if (thick[k] > tMax) tMax = thick[k];
          aSum += alpha[k]; aN++;
          if (gap[k] < gMin) gMin = gap[k];
        }
        marks.push({
          id: id++, side, start, length,
          thickness: tMax,
          gap: gMin === Infinity ? 0 : gMin,
          meanAlpha: aN ? Math.round(aSum / aN) : 0,
        });
      }
      p = lastHit + 1;
    }
  }

  return { marks, width: w, height: h };
}

/** Clear the pixels belonging to the given marks. Returns a new ImageData. */
export function removeMarks(img: ImageData, marks: EdgeMark[]): ImageData {
  const { width: w, height: h } = img;
  const out = new ImageData(new Uint8ClampedArray(img.data), w, h);
  const d = out.data;
  const band = Math.max(BAND_MIN, Math.min(BAND_MAX, Math.round(Math.min(w, h) * BAND_FRAC)));

  for (const m of marks) {
    for (let k = m.start; k < m.start + m.length; k++) {
      for (let depth = 0; depth < band; depth++) {
        let x: number, y: number;
        if (m.side === 'top')         { x = k; y = depth; }
        else if (m.side === 'bottom') { x = k; y = h - 1 - depth; }
        else if (m.side === 'left')   { x = depth; y = k; }
        else                          { x = w - 1 - depth; y = k; }
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        const i = (y * w + x) * 4;
        // Stop at the first empty pixel: that is the far side of the mark.
        if (d[i + 3] <= EMPTY_ALPHA) break;
        d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;
      }
    }
  }
  return out;
}
