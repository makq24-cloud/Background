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
/**
 * When measuring the clear gap behind a mark, pixels at or below this alpha
 * still count as clear: upscaling leaves a faint halo (alpha ~20-70) beside
 * hard lines, and that halo must not read as "artwork right behind it".
 */
const GAP_ALPHA = 96;

/** How far in from each edge we look, as a fraction of the short dimension. */
const BAND_FRAC = 0.012;
/** Absolute clamps on that band, in pixels. */
const BAND_MIN = 10;
const BAND_MAX = 90;

/** A mark may be at most this thick (px) measured inward from the edge. */
const MAX_THICK = 6;
/** ...or this fraction of the art's short side, whichever is larger (12px at 4800). */
const MAX_THICK_FRAC = 0.0025;
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
/** How far in from the edge a line may start (px, before scaling). */
const LEAD = 8;

export type EdgeSide = 'top' | 'bottom' | 'left' | 'right';

export type EdgeMark = {
  id: number;
  side: EdgeSide;
  /** Start position along the edge, in canvas px. */
  start: number;
  /** Length along the edge, in canvas px. */
  length: number;
  /** Thickness measured inward from the edge, in canvas px. */
  thickness: number;
  /** Clear px between this mark and the nearest artwork, inward. */
  gap: number;
  /** Mean alpha of the mark's pixels (0-255). */
  meanAlpha: number;
  /**
   * Distance from the canvas side to the edge that was scanned. 0 when the
   * artwork reaches the canvas edge; >0 when the art was placed with padding
   * (e.g. Fit on a platen with a different aspect ratio).
   */
  inset: number;
  /** How deep (from the scanned edge) the mark's ink reaches, incl. any lead-in. */
  depth?: number;
};

export type EdgeScan = {
  marks: EdgeMark[];
  width: number;
  height: number;
};

/**
 * Where the artwork sits on the canvas, and how much it was resized.
 *
 * Marks live on the edges of the ARTWORK, not the canvas. After the Platen
 * step those are not the same thing: Fit leaves padding on two sides, and
 * the art is usually scaled up, so a 2px line in the source arrives as a
 * 5-8px line (plus resample fringe). Thresholds are scaled to match.
 */
export type EdgeScanOptions = {
  rect?: { x: number; y: number; w: number; h: number } | null;
  scale?: number;
};

type Bounds = { x0: number; y0: number; x1: number; y1: number };

function boundsFor(w: number, h: number, rect?: EdgeScanOptions['rect']): Bounds {
  if (!rect) return { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  const x0 = Math.max(0, Math.min(w - 1, Math.round(rect.x)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(rect.y)));
  const x1 = Math.max(x0, Math.min(w - 1, Math.round(rect.x + rect.w) - 1));
  const y1 = Math.max(y0, Math.min(h - 1, Math.round(rect.y + rect.h) - 1));
  return { x0, y0, x1, y1 };
}

/** Canvas coordinate of position p along a side, depth d inward. */
function at(b: Bounds, side: EdgeSide, p: number, d: number): [number, number] {
  if (side === 'top')    return [b.x0 + p, b.y0 + d];
  if (side === 'bottom') return [b.x0 + p, b.y1 - d];
  if (side === 'left')   return [b.x0 + d, b.y0 + p];
  return [b.x1 - d, b.y0 + p];
}

function thresholds(b: Bounds, scale = 1) {
  const k = Math.max(1, scale);
  const short = Math.min(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1);
  return {
    band: Math.max(BAND_MIN, Math.min(Math.round(BAND_MAX * k), Math.round(short * BAND_FRAC))),
    // +2 for resample fringe. On print-size files a stray line is often
    // 5-8px with a light halo, so the ceiling also grows with the art.
    maxThick: Math.max(Math.round(MAX_THICK * k) + 2, Math.round(short * MAX_THICK_FRAC)),
    minRun: Math.round(MIN_RUN * k),
    minGap: Math.round(MIN_GAP * k),
    bridge: Math.round(BRIDGE * k),
    // A stray line doesn't always touch the edge: resampling can leave an
    // empty outer pixel, and real lines sit a few px in or drift (slant).
    // Skip up to this much empty space before looking for the ink.
    lead: Math.round(LEAD * k),
  };
}

/** Alpha at (x,y). */
function alphaAt(d: Uint8ClampedArray, w: number, x: number, y: number): number {
  return d[(y * w + x) * 4 + 3];
}

/**
 * For one edge, walk every position along it and measure how deep the ink
 * runs inward. Returns, per position: thickness of the edge-hugging ink
 * (0 if the edge itself is empty), and the gap of empty pixels that follows
 * it before any further ink.
 */
function profileEdge(
  data: Uint8ClampedArray, w: number, b: Bounds, side: EdgeSide, band: number, lead: number,
): { thick: Int32Array; gap: Int32Array; alpha: Int32Array; end: Int32Array } {
  const along = (side === 'top' || side === 'bottom') ? b.x1 - b.x0 + 1 : b.y1 - b.y0 + 1;
  const depthMax = (side === 'top' || side === 'bottom') ? b.y1 - b.y0 + 1 : b.x1 - b.x0 + 1;
  const lim = Math.min(band, depthMax);
  const thick = new Int32Array(along);
  const gap = new Int32Array(along);
  const alpha = new Int32Array(along);
  const end = new Int32Array(along);

  for (let p = 0; p < along; p++) {
    let d = 0;
    // Skip a near-empty resample fringe right at the edge.
    while (d < lead && d < lim) {
      const [x, y] = at(b, side, p, d);
      if (alphaAt(data, w, x, y) > EMPTY_ALPHA) break;
      d++;
    }
    if (d >= lead) {
      const [x, y] = at(b, side, p, d < lim ? d : lim - 1);
      if (alphaAt(data, w, x, y) <= EMPTY_ALPHA) continue;
    }
    let run = 0, sum = 0;
    for (; d < lim; d++) {
      const [x, y] = at(b, side, p, d);
      const a = alphaAt(data, w, x, y);
      if (a <= EMPTY_ALPHA) break;
      run++; sum += a;
    }
    thick[p] = run;
    alpha[p] = run ? Math.round(sum / run) : 0;
    end[p] = d;

    let g = 0;
    if (run > 0) {
      for (; d < lim; d++) {
        const [x, y] = at(b, side, p, d);
        // Faint resample ringing behind a line is not artwork.
        if (alphaAt(data, w, x, y) > GAP_ALPHA) break;
        g++;
      }
    }
    gap[p] = g;
  }
  return { thick, gap, alpha, end };
}

/**
 * A stray line is uniform: nearly every position along it is ink, at nearly
 * the same thickness. Spray, splatter and dot clusters that happen to touch
 * the edge are ragged — gaps between dots and wildly varying depth.
 */
function isLineLike(thick: Int32Array, isMark: Uint8Array, a: number, b: number): boolean {
  const ts: number[] = [];
  for (let k = a; k <= b; k++) if (isMark[k]) ts.push(thick[k]);
  const len = b - a + 1;
  // Dashed lines are fine; scattered dots fill far less of the run.
  if (ts.length < len * 0.6) return false;
  ts.sort((x, y) => x - y);
  const med = ts[ts.length >> 1];
  const tol = Math.max(2, Math.round(med * 0.35));
  let ok = 0;
  for (const t of ts) if (Math.abs(t - med) <= tol) ok++;
  if (ok >= ts.length * 0.8) return true;
  // Tapers and spindles vary a lot end to end but change smoothly from one
  // position to the next; splatter jumps around.
  let smooth = 0, pairs = 0, prev = -1;
  for (let k = a; k <= b; k++) {
    if (!isMark[k]) { prev = -1; continue; }
    if (prev >= 0) { pairs++; if (Math.abs(thick[k] - prev) <= 1) smooth++; }
    prev = thick[k];
  }
  return pairs > 0 && smooth >= pairs * 0.9;
}

/**
 * Scan all four edges of the artwork. A position is "mark-like" when it has
 * ink hugging the edge, that ink is thin, and there is clear space behind it.
 * Contiguous mark-like positions (bridging small breaks) become one mark.
 */
export function findEdgeMarks(img: ImageData, opts: EdgeScanOptions = {}): EdgeScan {
  const { width: w, height: h, data } = img;
  const b = boundsFor(w, h, opts.rect);
  const T = thresholds(b, opts.scale);
  const marks: EdgeMark[] = [];
  let id = 1;

  for (const side of ['top', 'bottom', 'left', 'right'] as EdgeSide[]) {
    const { thick, gap, alpha, end } = profileEdge(data, w, b, side, T.band, T.lead);
    const n = thick.length;
    const isMark = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      // Thin ink on the edge, with real clear space behind it. A gap that
      // runs to the end of the band counts — nothing found means nothing near.
      if (thick[p] > 0 && thick[p] <= T.maxThick &&
          (gap[p] >= T.minGap || thick[p] + gap[p] >= T.band - T.lead)) {
        isMark[p] = 1;
      }
    }

    const horizontal = side === 'top' || side === 'bottom';
    const offset = horizontal ? b.x0 : b.y0;
    const inset = side === 'top' ? b.y0 : side === 'bottom' ? h - 1 - b.y1
      : side === 'left' ? b.x0 : w - 1 - b.x1;

    let p = 0;
    while (p < n) {
      if (!isMark[p]) { p++; continue; }
      let q = p;
      let lastHit = p;
      while (q < n) {
        if (isMark[q]) { lastHit = q; q++; continue; }
        // Allow a short break before giving up on the run.
        let probe = q;
        while (probe < n && probe - lastHit <= T.bridge && !isMark[probe]) probe++;
        if (probe < n && probe - lastHit <= T.bridge && isMark[probe]) { q = probe; continue; }
        break;
      }
      const length = lastHit - p + 1;
      if (length >= T.minRun && isLineLike(thick, isMark, p, lastHit)) {
        let tMax = 0, aSum = 0, aN = 0, gMin = Infinity, eMax = 0;
        for (let k = p; k <= lastHit; k++) {
          if (!isMark[k]) continue;
          if (thick[k] > tMax) tMax = thick[k];
          if (end[k] > eMax) eMax = end[k];
          aSum += alpha[k]; aN++;
          if (gap[k] < gMin) gMin = gap[k];
        }
        marks.push({
          id: id++, side, start: offset + p, length,
          thickness: tMax,
          gap: gMin === Infinity ? 0 : gMin,
          meanAlpha: aN ? Math.round(aSum / aN) : 0,
          inset,
          depth: eMax,
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

  for (const m of marks) {
    const inset = m.inset ?? 0;
    // Mark ink is at most `thickness` deep, possibly behind a thin empty
    // resample fringe; never reach past that.
    const maxDepth = (m.depth ?? m.thickness) + Math.max(2, Math.ceil(m.thickness / 3));
    for (let k = m.start; k < m.start + m.length; k++) {
      let seenInk = false;
      for (let depth = 0; depth < maxDepth; depth++) {
        let x: number, y: number;
        if (m.side === 'top')         { x = k; y = inset + depth; }
        else if (m.side === 'bottom') { x = k; y = h - 1 - inset - depth; }
        else if (m.side === 'left')   { x = inset + depth; y = k; }
        else                          { x = w - 1 - inset - depth; y = k; }
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        const i = (y * w + x) * 4;
        if (d[i + 3] <= EMPTY_ALPHA) {
          // Leading fringe: keep going. After the ink: far side of the mark.
          if (seenInk) break;
          continue;
        }
        seenInk = true;
        d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;
      }
    }
  }
  return out;
}
