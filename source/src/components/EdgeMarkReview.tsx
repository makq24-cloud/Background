import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { EdgeMark } from '../utils/edgeMarks';
import { imageDataToCanvas } from '../utils/imageUtils';

type Backdrop = 'auto' | 'dark' | 'white' | 'checker' | 'custom';

type Props = {
  image: ImageData;
  marks: EdgeMark[];
  onRemoveAll: () => void;
  onKeep: () => void;
};

/**
 * How many screen px a 1px mark is drawn as in the overview. A real mark is
 * 1-3px, which is sub-pixel once a 4800px design is fitted to a phone — so
 * the marker is deliberately fattened. It stays anchored to the mark's true
 * position; only its thickness is exaggerated.
 */
const MARKER_PX = 7;
/** Zoom factor in the per-mark detail view (1 image px -> N screen px). */
const ZOOM = 4;

/** Where a mark's pixels sit, as a rectangle in image coordinates. */
function markRect(img: ImageData, m: EdgeMark) {
  const ins = m.inset ?? 0;
  const depth = Math.max(1, m.depth ?? m.thickness);
  if (m.side === 'top')    return { x: m.start, y: ins, w: m.length, h: depth };
  if (m.side === 'bottom') return { x: m.start, y: img.height - ins - depth, w: m.length, h: depth };
  if (m.side === 'left')   return { x: ins, y: m.start, w: depth, h: m.length };
  return { x: img.width - ins - depth, y: m.start, w: depth, h: m.length };
}

/** Mean colour of the visible pixels in a rectangle, or null if none. */
function meanColor(img: ImageData, r: { x: number; y: number; w: number; h: number }) {
  let rs = 0, gs = 0, bs = 0, n = 0;
  const x1 = Math.min(img.width, r.x + r.w), y1 = Math.min(img.height, r.y + r.h);
  const step = Math.max(1, Math.floor((r.w * r.h) / 4000));
  let k = 0;
  for (let y = Math.max(0, r.y); y < y1; y++) for (let x = Math.max(0, r.x); x < x1; x++) {
    if (k++ % step) continue;
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] <= 8) continue;
    rs += img.data[i]; gs += img.data[i + 1]; bs += img.data[i + 2]; n++;
  }
  return n ? { r: rs / n, g: gs / n, b: bs / n } : null;
}

function paintBackdrop(
  ctx: CanvasRenderingContext2D, w: number, h: number, mode: Backdrop, custom: string,
) {
  if (mode === 'checker') {
    const sz = 8;
    for (let y = 0; y < h; y += sz) {
      for (let x = 0; x < w; x += sz) {
        ctx.fillStyle = ((Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0) ? '#374151' : '#4b5563';
        ctx.fillRect(x, y, sz, sz);
      }
    }
    return;
  }
  ctx.fillStyle = mode === 'white' ? '#ffffff' : mode === 'custom' ? custom : '#18181b';
  ctx.fillRect(0, 0, w, h);
}

export default function EdgeMarkReview({ image, marks, onRemoveAll, onKeep }: Props) {
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const detailRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // Auto: each mark is shown on whichever backdrop contrasts with ITS colour
  // — dark lines on white, light lines on dark — so a black-on-black or
  // white-on-white line can't hide. The buttons still override it.
  const [backdrop, setBackdrop] = useState<Backdrop>('auto');
  const [customColor, setCustomColor] = useState('#888888');

  const srcCanvas = useMemo(() => imageDataToCanvas(image), [image]);
  const mark = selected === null ? null : marks.find(m => m.id === selected) ?? null;

  // Overview: the design, fitted, with every mark drawn fat and red.
  useEffect(() => {
    const cv = overviewRef.current;
    if (!cv || mark) return;
    const maxW = cv.parentElement?.clientWidth ?? 320;
    const scale = Math.min(maxW / image.width, 420 / image.height);
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d')!;
    paintBackdrop(ctx, w, h, backdrop === 'auto' ? 'checker' : backdrop, customColor);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, 0, 0, w, h);

    ctx.fillStyle = '#e24b4a';
    for (const m of marks) {
      const a0 = m.start * scale;
      const len = Math.max(3, m.length * scale);
      const ins = (m.inset ?? 0) * scale;
      if (m.side === 'top')         ctx.fillRect(a0, ins, len, MARKER_PX);
      else if (m.side === 'bottom') ctx.fillRect(a0, h - ins - MARKER_PX, len, MARKER_PX);
      else if (m.side === 'left')   ctx.fillRect(ins, a0, MARKER_PX, len);
      else                          ctx.fillRect(w - ins - MARKER_PX, a0, MARKER_PX, len);
    }
  }, [srcCanvas, image, marks, backdrop, customColor, mark]);

  // Detail: real pixels around one mark, no smoothing.
  useEffect(() => {
    const cv = detailRef.current;
    if (!cv || !mark) return;
    const pad = 14;
    const thick = Math.max(mark.thickness, 1) + mark.gap + pad;
    const along = Math.min(mark.length + pad * 2, 260);
    const alongStart = Math.max(0, mark.start - pad);

    const horizontal = mark.side === 'top' || mark.side === 'bottom';
    const cw = horizontal ? along : thick;
    const chh = horizontal ? thick : along;
    let sx = 0, sy = 0;
    const ins = mark.inset ?? 0;
    if (mark.side === 'top')         { sx = alongStart; sy = ins; }
    else if (mark.side === 'bottom') { sx = alongStart; sy = image.height - ins - thick; }
    else if (mark.side === 'left')   { sx = ins; sy = alongStart; }
    else                             { sx = image.width - ins - thick; sy = alongStart; }

    cv.width = cw * ZOOM; cv.height = chh * ZOOM;
    const ctx = cv.getContext('2d')!;
    const mr = markRect(image, mark);
    const lineColor = meanColor(image, mr);
    let bd: Backdrop = backdrop;
    if (bd === 'auto') {
      const lum = lineColor ? 0.299 * lineColor.r + 0.587 * lineColor.g + 0.114 * lineColor.b : 255;
      bd = lum < 128 ? 'white' : 'dark';
    }
    paintBackdrop(ctx, cv.width, cv.height, bd, customColor);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(srcCanvas, sx, sy, cw, chh, 0, 0, cw * ZOOM, chh * ZOOM);

    // Outline AROUND the line (never over it), so its real pixels stay
    // visible. Orange, or cyan when the art next to it is orange/red.
    const near = meanColor(image, { x: sx, y: sy, w: cw, h: chh });
    const warm = near && near.r > near.g + 40 && near.r > near.b + 20;
    const ox = (mr.x - sx) * ZOOM, oy = (mr.y - sy) * ZOOM;
    const ow = mr.w * ZOOM, oh = mr.h * ZOOM;
    const op = 5;
    ctx.strokeStyle = warm ? '#22d3ee' : '#ff8a3d';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 6]);
    ctx.strokeRect(ox - op, oy - op, ow + op * 2, oh + op * 2);
    ctx.setLineDash([]);
  }, [srcCanvas, image, mark, backdrop, customColor]);

  const backdrops: { id: Backdrop; label: string }[] = [
    { id: 'auto', label: 'Auto' },
    { id: 'dark', label: 'Dark' },
    { id: 'white', label: 'White' },
    { id: 'checker', label: 'Checker' },
    { id: 'custom', label: 'Custom' },
  ];

  return (
    <div className="absolute inset-0 z-20 bg-gray-900 flex flex-col">
      <div className="flex items-start gap-2 px-4 py-3 bg-amber-950 border-b border-amber-900/70">
        <AlertTriangle size={18} className="text-amber-300 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-amber-200 text-sm font-semibold">
            {marks.length} edge {marks.length === 1 ? 'mark' : 'marks'} found
          </p>
          <p className="text-amber-400/80 text-xs mt-0.5">
            Thin, isolated from the artwork — tap one to zoom
          </p>
        </div>
        {mark && (
          <button onClick={() => setSelected(null)}
            className="p-1 text-amber-300 hover:text-amber-100" title="Back to all">
            <X size={18} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {!mark ? (
          <>
            <div className="flex justify-center"><canvas ref={overviewRef} className="rounded" /></div>
            <p className="text-gray-500 text-[11px] text-center mt-2">
              Marks drawn thicker than actual size
            </p>
            <div className="mt-3 space-y-1.5">
              {marks.map(m => (
                <button key={m.id} onClick={() => setSelected(m.id)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded text-left transition">
                  <span className="text-sm text-gray-200 capitalize">{m.side} edge</span>
                  <span className="text-xs text-gray-400 tabular-nums">
                    {m.thickness}px · {m.length}px long · {m.gap}px gap
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="text-gray-300 text-sm mb-1 capitalize">
              {mark.side} edge · {mark.thickness}px · {ZOOM}× zoom
            </p>
            <p className="text-gray-500 text-xs mb-3">
              {mark.gap}px of clear space between this and your artwork
            </p>
            <div className="flex justify-center overflow-auto">
              <canvas ref={detailRef} className="rounded border border-gray-700 max-w-full" />
            </div>
          </>
        )}

        <div className="flex gap-1.5 mt-4">
          {backdrops.map(b => (
            <button key={b.id} onClick={() => setBackdrop(b.id)}
              className={`flex-1 px-2 py-1.5 rounded text-xs transition ${
                backdrop === b.id ? 'bg-amber-500 text-amber-950 font-semibold'
                                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>
              {b.label}
            </button>
          ))}
        </div>
        {backdrop === 'custom' && (
          <input type="color" value={customColor} onChange={e => setCustomColor(e.target.value)}
            className="mt-2 w-full h-8 bg-transparent cursor-pointer" />
        )}
      </div>

      <div className="p-4 border-t border-gray-800 flex gap-2">
        <button onClick={onRemoveAll}
          className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold text-white transition">
          Remove all {marks.length}
        </button>
        <button onClick={onKeep}
          className="px-5 py-3 border border-gray-600 hover:bg-gray-800 rounded-lg text-gray-300 transition">
          Keep
        </button>
      </div>
    </div>
  );
}
