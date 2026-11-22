import type { AppState } from '../App';
import type { EdgeScanOptions } from './edgeMarks';

/**
 * Edge-scan options for the current canvas: the placed art's rectangle and
 * resize factor from the Platen step. Ignored if the canvas no longer matches
 * the platen it was placed on (e.g. after a Trim).
 */
export function edgeScanOpts(state: AppState): EdgeScanOptions {
  const p = state.artPlacement;
  const c = state.canvasData;
  const d = state.platenDimensions;
  if (!p || !c || !d || c.width !== d.width || c.height !== d.height) return {};
  return { rect: { x: p.x, y: p.y, w: p.w, h: p.h }, scale: p.scale };
}
