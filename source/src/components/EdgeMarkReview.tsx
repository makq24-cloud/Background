import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { EdgeMark } from '../utils/edgeMarks';
import { imageDataToCanvas } from '../utils/imageUtils';

type Backdrop = 'dark' | 'white' | 'checker' | 'custom';

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
  // Dark by default: these marks are usually light or mid-grey, and white
  // hides them completely — which is why they get missed in the first place.
  const [backdrop, setBackdrop] = useState<Backdrop>('dark');
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
    paintBackdrop(ctx, w, h, backdrop, customColor);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, 0, 0, w, h);

    ctx.fillStyle = '#e24b4a';
    for (const m of marks) {
      const a0 = m.start * scale;
      const len = Math.max(3, m.length * scale);
      if (m.side === 'top')         ctx.fillRect(a0, 0, len, MARKER_PX);
      else if (m.side === 'bottom') ctx.fillRect(a0, h - MARKER_PX, len, MARKER_PX);
      else if (m.side === 'left')   ctx.fillRect(0, a0, MARKER_PX, len);
      else                          ctx.fillRect(w - MARKER_PX, a0, MARKER_PX, len);
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
    if (mark.side === 'top')         { sx = alongStart; sy = 0; }
    else if (mark.side === 'bottom') { sx = alongStart; sy = image.height - thick; }
    else if (mark.side === 'left')   { sx = 0; sy = alongStart; }
    else                             { sx = image.width - thick; sy = alongStart; }

    cv.width = cw * ZOOM; cv.height = chh * ZOOM;
    const ctx = cv.getContext('2d')!;
    paintBackdrop(ctx, cv.width, cv.height, backdrop, customColor);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(srcCanvas, sx, sy, cw, chh, 0, 0, cw * ZOOM, chh * ZOOM);
  }, [srcCanvas, image, mark, backdrop, customColor]);

  const backdrops: { id: Backdrop; label: string }[] = [
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
