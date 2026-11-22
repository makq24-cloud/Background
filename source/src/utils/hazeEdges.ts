/**
 * Cut-off haze detection.
 *
 * A soft, semi-transparent background (airbrush glow, sky, smoke) that runs
 * right up to the edge of the artwork ends in a perfectly straight line. On
 * screen that is invisible; on fabric the faint tint stops dead and prints as
 * a hard line across the shirt.
 *
 * This finds stretches of an edge where FAINT ink runs continuously into the
 * boundary, and fades only that faint ink, only along those stretches. Real
 * artwork is protected by opacity: in colour-to-alpha output, text, photos and
 * flowers sit well above the haze ceiling, and anything above it is never
 * touched. The trade-off is deliberate — a dense glow (alpha well above the
 * ceiling) cut at the edge is not handled, because it can't be told apart
 * from a photo cropped at the edge on purpose.
 */

import type { EdgeScanOptions } from './edgeMarks';

export type EdgeSide = 'top' | 'bottom' | 'left' | 'right';

export type HazeRun = { start: number; end: number };

export type HazeEdge = {
  side: EdgeSide;
  /** Stretches of this edge (positions along it, inclusive) with cut-off haze. */
  runs: HazeRun[];
  /** Fraction of the edge (0-1) covered by those stretches. */
  coverage: number;
  /** Longest stretch, in px. */
  longestRun: number;
  /** Mean alpha of the haze along those stretches. */
  meanAlpha: number;
};

/** Ink at or below this alpha is already invisible (matches MIN_ALPHA). */
const EMPTY_ALPHA = 8;
/** Haze ceiling: faint background ink. Above this is treated as artwork. */
const HAZE_MAX = 110;
/** Fade weight ramps from full (≤ HAZE_MAX-20) to none (≥ HAZE_MAX+20). */
const BLEND = 20;
/** How far in from the edge to look for the haze (handles fringe / padding). */
const SAMPLE_DEPTH = 6;
/** The haze must stay faint this far inward — rules out anti-aliased solid art. */
const BODY_DEPTH = 12;
/** Shortest stretch that counts (≈0.25in at 300dpi). */
const MIN_RUN_PX = 75;
/** Gaps up to this long don't split a stretch. */
const BRIDGE_PX = 12;
/** A stretch must be at least this dense with haze (rules out spray/speckle). */
const MIN_DENSITY = 0.7;
/** Fade distance, as a fraction of the art's short side (≈0.5in at 4800px). */
const FADE_FRAC = 0.03;

type Bounds = { x0: number; y0: number; x1: number; y1: number };

function boundsFor(w: number, h: number, rect?: EdgeScanOptions['rect']): Bounds {
  if (!rect) return { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  const x0 = Math.max(0, Math.min(w - 1, Math.round(rect.x)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(rect.y)));
  const x1 = Math.max(x0, Math.min(w - 1, Math.round(rect.x + rect.w) - 1));
  const y1 = Math.max(y0, Math.min(h - 1, Math.round(rect.y + rect.h) - 1));
  return { x0, y0, x1, y1 };
}

function at(b: Bounds, side: EdgeSide, p: number, d: number): [number, number] {
  if (side === 'top')    return [b.x0 + p, b.y0 + d];
  if (side === 'bottom') return [b.x0 + p, b.y1 - d];
  if (side === 'left')   return [b.x0 + d, b.y0 + p];
  return [b.x1 - d, b.y0 + p];
}

function hazeWeight(a: number): number {
  if (a <= EMPTY_ALPHA) return 0;
  return Math.min(1, Math.max(0, (HAZE_MAX + BLEND - a) / (2 * BLEND)));
}

export function findHazeEdges(img: ImageData, opts: EdgeScanOptions = {}): HazeEdge[] {
  const { width: w, height: h, data } = img;
  const b = boundsFor(w, h, opts.rect);
  const out: HazeEdge[] = [];
  const A = (x: number, y: number) => data[(y * w + x) * 4 + 3];

  for (const side of ['top', 'bottom', 'left', 'right'] as EdgeSide[]) {
    const horizontal = side === 'top' || side === 'bottom';
    const along = horizontal ? b.x1 - b.x0 + 1 : b.y1 - b.y0 + 1;
    const deep = horizontal ? b.y1 - b.y0 + 1 : b.x1 - b.x0 + 1;
    const sd = Math.min(SAMPLE_DEPTH, deep);
    const bd = Math.min(BODY_DEPTH, deep);

    // Per position: is there faint haze reaching the edge, staying faint inward?
    const isHaze = new Uint8Array(along);
    const hazeA = new Uint16Array(along);
    for (let p = 0; p < along; p++) {
      // First ink within the outer few px.
      let d = 0;
      for (; d < sd; d++) { const [x, y] = at(b, side, p, d); if (A(x, y) > EMPTY_ALPHA) break; }
      if (d >= sd) continue;
      // It, and the next BODY_DEPTH px, must be faint and present.
      let ok = true, sum = 0, n = 0;
      for (let k = d; k < Math.min(deep, d + bd); k++) {
        const [x, y] = at(b, side, p, k);
        const a = A(x, y);
        if (a > HAZE_MAX) { ok = false; break; }
        sum += a; n++;
      }
      if (ok && n > 0 && sum / n > EMPTY_ALPHA) { isHaze[p] = 1; hazeA[p] = Math.round(sum / n); }
    }

    // Group into stretches; keep long, dense ones.
    const runs: HazeRun[] = [];
    let total = 0, aSum = 0, aN = 0, longest = 0;
    let p = 0;
    while (p < along) {
      if (!isHaze[p]) { p++; continue; }
      let last = p, q = p + 1, hits = 1, s = hazeA[p];
      while (q < along && q - last <= BRIDGE_PX) {
        if (isHaze[q]) { last = q; hits++; s += hazeA[q]; }
        q++;
      }
      const len = last - p + 1;
      if (len >= MIN_RUN_PX && hits / len >= MIN_DENSITY) {
        runs.push({ start: p, end: last });
        total += len; aSum += s; aN += hits;
        if (len > longest) longest = len;
      }
      p = last + 1;
    }
    if (runs.length) {
      out.push({ side, runs, coverage: total / along, longestRun: longest, meanAlpha: Math.round(aSum / aN) });
    }
  }
  return out;
}

/**
 * Fade the faint haze along the flagged stretches so it dissolves to nothing
 * at the edge. Returns a new ImageData. Pixels above the haze ceiling are
 * never changed; the fade also stops at the first one it meets walking inward,
 * so nothing behind real artwork is touched.
 */
export function fadeHazeEdges(img: ImageData, edges: HazeEdge[], opts: EdgeScanOptions = {}): ImageData {
  const { width: w, height: h } = img;
  const out = new ImageData(new Uint8ClampedArray(img.data), w, h);
  if (edges.length === 0) return out;
  const d = out.data;
  const b = boundsFor(w, h, opts.rect);
  const short = Math.min(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1);
  const F = Math.max(24, Math.round(short * FADE_FRAC));

  // Per pixel, keep the strongest fade requested (corners where two edges meet).
  const factor = new Map<number, number>();

  for (const e of edges) {
    const horizontal = e.side === 'top' || e.side === 'bottom';
    const along = horizontal ? b.x1 - b.x0 + 1 : b.y1 - b.y0 + 1;
    const deep = horizontal ? b.y1 - b.y0 + 1 : b.x1 - b.x0 + 1;
    const depth = Math.min(F, deep);
    for (const r of e.runs) {
      // Taper the fade in over a short margin past each end of the stretch,
      // so the faded part doesn't start with a visible step along the edge.
      const margin = Math.round(F / 2);
      for (let p = Math.max(0, r.start - margin); p <= Math.min(along - 1, r.end + margin); p++) {
        const endT = p < r.start ? (r.start - p) / margin : p > r.end ? (p - r.end) / margin : 0;
        for (let k = 0; k < depth; k++) {
          const [x, y] = at(b, e.side, p, k);
          const i = (y * w + x) * 4;
          const a = img.data[i + 3];
          if (a > HAZE_MAX + BLEND) break;      // real artwork: stop here
          const wgt = hazeWeight(a);
          if (wgt === 0) continue;
          const t = Math.min(1, (k + 0.5) / F + endT);
          const fade = t * t * (3 - 2 * t);
          const f = 1 - wgt * (1 - fade);
          const prev = factor.get(i);
          if (prev === undefined || f < prev) factor.set(i, f);
        }
      }
    }
  }

  for (const [i, f] of factor) {
    const na = Math.round(img.data[i + 3] * f);
    if (na <= EMPTY_ALPHA) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0; }
    else d[i + 3] = na;
  }
  return out;
}
