/**
 * Cut-off haze detection.
 *
 * A soft, semi-transparent background (airbrush glow, sky, smoke) that runs
 * right up to the edge of the artwork ends in a perfectly straight line. On
 * screen that is invisible; on fabric the faint tint stops dead and prints as
 * a hard line across the shirt.
 *
 * This finds edges where faint ink is present along a long stretch of the
 * artwork's boundary, and fades that ink out gradually so the haze dissolves
 * instead of stopping. Solid artwork is left alone: the fade only applies to
 * semi-transparent pixels, so a deliberate full-opacity bleed stays crisp.
 */

import type { EdgeScanOptions } from './edgeMarks';

export type EdgeSide = 'top' | 'bottom' | 'left' | 'right';

export type HazeEdge = {
  side: EdgeSide;
  /** Fraction of the edge (0-1) covered by cut-off haze. */
  coverage: number;
  /** Longest continuous cut-off stretch, in px. */
  longestRun: number;
  /** Mean alpha of the haze along the edge. */
  meanAlpha: number;
};

/** Ink at or below this alpha is already invisible (matches MIN_ALPHA). */
const EMPTY_ALPHA = 8;
/** Above this, the edge pixel is solid artwork — a bleed, not haze. */
const HAZE_MAX_ALPHA = 200;
/** How many px in from the edge to sample (handles 1px resample fringe). */
const SAMPLE_DEPTH = 3;
/** A stretch shorter than this fraction of the edge is ignored. */
const MIN_RUN_FRAC = 0.04;
/** ...and never shorter than this many px. */
const MIN_RUN_PX = 80;
/** Small breaks (a letter crossing the edge) don't split a stretch. */
const BRIDGE_FRAC = 0.01;
/** Fade distance, as a fraction of the art's short side (≈0.5" at 4800px). */
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

export function findHazeEdges(img: ImageData, opts: EdgeScanOptions = {}): HazeEdge[] {
  const { width: w, height: h, data } = img;
  const b = boundsFor(w, h, opts.rect);
  const out: HazeEdge[] = [];

  for (const side of ['top', 'bottom', 'left', 'right'] as EdgeSide[]) {
    const along = (side === 'top' || side === 'bottom') ? b.x1 - b.x0 + 1 : b.y1 - b.y0 + 1;
    const bridge = Math.max(4, Math.round(along * BRIDGE_FRAC));
    const minRun = Math.max(MIN_RUN_PX, Math.round(along * MIN_RUN_FRAC));

    let hazeCount = 0, aSum = 0;
    let longest = 0, runStart = -1, lastHit = -1;
    for (let p = 0; p < along; p++) {
      // Strongest alpha within the outer few px of the edge.
      let a = 0;
      for (let d = 0; d < SAMPLE_DEPTH; d++) {
        const [x, y] = at(b, side, p, d);
        const v = data[(y * w + x) * 4 + 3];
        if (v > a) a = v;
      }
      const isHaze = a > EMPTY_ALPHA && a <= HAZE_MAX_ALPHA;
      if (isHaze) {
        hazeCount++; aSum += a;
        if (runStart < 0 || p - lastHit > bridge) runStart = p;
        lastHit = p;
        if (lastHit - runStart + 1 > longest) longest = lastHit - runStart + 1;
      }
    }
    if (longest >= minRun) {
      out.push({
        side,
        coverage: hazeCount / along,
        longestRun: longest,
        meanAlpha: hazeCount ? Math.round(aSum / hazeCount) : 0,
      });
    }
  }
  return out;
}

/**
 * Fade semi-transparent ink toward the given edges. Returns a new ImageData.
 * Opaque pixels are untouched; faint pixels fade fully; in between blends.
 */
export function fadeHazeEdges(img: ImageData, edges: HazeEdge[], opts: EdgeScanOptions = {}): ImageData {
  const { width: w, height: h } = img;
  const out = new ImageData(new Uint8ClampedArray(img.data), w, h);
  if (edges.length === 0) return out;
  const d = out.data;
  const b = boundsFor(w, h, opts.rect);
  const short = Math.min(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1);
  const F = Math.max(24, Math.round(short * FADE_FRAC));
  const sides = new Set(edges.map(e => e.side));

  const x0 = b.x0, x1 = b.x1, y0 = b.y0, y1 = b.y1;
  for (let y = y0; y <= y1; y++) {
    const dy = Math.min(sides.has('top') ? y - y0 : Infinity, sides.has('bottom') ? y1 - y : Infinity);
    for (let x = x0; x <= x1; x++) {
      const dx = Math.min(sides.has('left') ? x - x0 : Infinity, sides.has('right') ? x1 - x : Infinity);
      const dist = Math.min(dx, dy);
      if (dist >= F) continue;
      const i = (y * w + x) * 4;
      const a = d[i + 3];
      if (a === 0 || a === 255) continue;
      // Smoothstep from 0 at the edge to 1 at distance F.
      const t = (dist + 0.5) / F;
      const fade = t * t * (3 - 2 * t);
      // How "hazy" this pixel is: 1 for faint, 0 for solid.
      const haze = Math.min(1, Math.max(0, (HAZE_MAX_ALPHA + 40 - a) / 80));
      const factor = 1 - haze * (1 - fade);
      const na = Math.round(a * factor);
      d[i + 3] = na <= EMPTY_ALPHA ? 0 : na;
      if (d[i + 3] === 0) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; }
    }
  }
  return out;
}
