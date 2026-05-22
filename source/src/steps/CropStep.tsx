import { useState, useRef, useEffect, useCallback } from 'react';
import { AppState } from '../App';
import { imageDataToCanvas, cropImageData, detectBoundingBox } from '../utils/imageUtils';

type Props = {
  state: AppState;
  updateState: (updates: Partial<AppState>) => void;
  goToStep: (step: number) => void;
};

type CropBox = { x: number; y: number; w: number; h: number };
type HandleId = 'tl' | 'tc' | 'tr' | 'ml' | 'mr' | 'bl' | 'bc' | 'br';
type DragState =
  | { kind: 'none' }
  | { kind: 'drawing'; sx: number; sy: number }
  | { kind: 'moving'; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'resizing'; handle: HandleId; sx: number; sy: number; snap: CropBox };

const HANDLE_RADIUS_PX = 8;
const HANDLE_HIT_PX = 26;
const MIN_DIM = 4;

function getHandles(crop: CropBox): Record<HandleId, { x: number; y: number }> {
  const { x, y, w, h } = crop;
  return {
    tl: { x, y },          tc: { x: x + w / 2, y },          tr: { x: x + w, y },
    ml: { x, y: y + h / 2 },                                   mr: { x: x + w, y: y + h / 2 },
    bl: { x, y: y + h },   bc: { x: x + w / 2, y: y + h },    br: { x: x + w, y: y + h },
  };
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function resizeFromHandle(snap: CropBox, handle: HandleId, dx: number, dy: number, imgW: number, imgH: number): CropBox {
  const { x, y, w, h } = snap;
  switch (handle) {
    case 'tl': {
      const nx = clamp(x + dx, 0, x + w - MIN_DIM);
      const ny = clamp(y + dy, 0, y + h - MIN_DIM);
      return { x: nx, y: ny, w: w - (nx - x), h: h - (ny - y) };
    }
    case 'tc': {
      const ny = clamp(y + dy, 0, y + h - MIN_DIM);
      return { x, y: ny, w, h: h - (ny - y) };
    }
    case 'tr': {
      const ny = clamp(y + dy, 0, y + h - MIN_DIM);
      return { x, y: ny, w: clamp(w + dx, MIN_DIM, imgW - x), h: h - (ny - y) };
    }
    case 'ml': {
      const nx = clamp(x + dx, 0, x + w - MIN_DIM);
      return { x: nx, y, w: w - (nx - x), h };
    }
    case 'mr': return { x, y, w: clamp(w + dx, MIN_DIM, imgW - x), h };
    case 'bl': {
      const nx = clamp(x + dx, 0, x + w - MIN_DIM);
      return { x: nx, y, w: w - (nx - x), h: clamp(h + dy, MIN_DIM, imgH - y) };
    }
    case 'bc': return { x, y, w, h: clamp(h + dy, MIN_DIM, imgH - y) };
    case 'br': return { x, y, w: clamp(w + dx, MIN_DIM, imgW - x), h: clamp(h + dy, MIN_DIM, imgH - y) };
  }
}

export default function TrimStep({ state, updateState, goToStep }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number>(0);

  const img = state.sourceImage;
  const imgW = img?.width ?? 0;
  const imgH = img?.height ?? 0;

  const [crop, setCrop] = useState<CropBox | null>(null);
  const [dragState, setDragState] = useState<DragState>({ kind: 'none' });
  const [cursor, setCursor] = useState('default');
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState<ImageData | null>(null);

  const [box, setBox] = useState({ w: 360, h: 440 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // The canvas hugs the image: scale the whole image to fit the available
  // area in BOTH dimensions, never above 1:1. No zoom, no scrolling.
  const renderScale = imgW > 0 && imgH > 0
    ? Math.min(box.w / imgW, box.h / imgH, 1)
    : 1;

  useEffect(() => {
    if (img) srcCanvasRef.current = imageDataToCanvas(img);
  }, [img]);

  useEffect(() => {
    if (img && !crop) setCrop({ x: 0, y: 0, w: imgW, h: imgH });
  }, [img, imgW, imgH]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const src = srcCanvasRef.current;
    if (!canvas || !src || !img) return;

    const rs = renderScale;
    const cssW = Math.max(1, Math.round(imgW * rs));
    const cssH = Math.max(1, Math.round(imgH * rs));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const bufW = Math.round(cssW * dpr);
    const bufH = Math.round(cssH * dpr);

    if (canvas.width !== bufW || canvas.height !== bufH) {
      canvas.width = bufW;
      canvas.height = bufH;
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
    }

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(src, 0, 0, cssW, cssH);

    if (crop) {
      const { x, y, w, h } = crop;
      const sx = x * rs, sy = y * rs, sw = w * rs, sh = h * rs;

      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, cssW, sy);
      ctx.fillRect(0, sy + sh, cssW, cssH - sy - sh);
      ctx.fillRect(0, sy, sx, sh);
      ctx.fillRect(sx + sw, sy, cssW - sx - sw, sh);

      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);

      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx + sw / 3, sy); ctx.lineTo(sx + sw / 3, sy + sh);
      ctx.moveTo(sx + 2 * sw / 3, sy); ctx.lineTo(sx + 2 * sw / 3, sy + sh);
      ctx.moveTo(sx, sy + sh / 3); ctx.lineTo(sx + sw, sy + sh / 3);
      ctx.moveTo(sx, sy + 2 * sh / 3); ctx.lineTo(sx + sw, sy + 2 * sh / 3);
      ctx.stroke();
      ctx.setLineDash([]);

      Object.values(getHandles(crop)).forEach(({ x: hx, y: hy }) => {
        const cx = clamp(hx * rs, HANDLE_RADIUS_PX, cssW - HANDLE_RADIUS_PX);
        const cy = clamp(hy * rs, HANDLE_RADIUS_PX, cssH - HANDLE_RADIUS_PX);
        ctx.beginPath();
        ctx.arc(cx, cy, HANDLE_RADIUS_PX, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      });
    }
  }, [img, imgW, imgH, renderScale, crop]);

  useEffect(() => {
    cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = requestAnimationFrame(draw);
  }, [draw]);

  const getImageCoords = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clamp((e.clientX - rect.left) / renderScale, 0, imgW),
      y: clamp((e.clientY - rect.top) / renderScale, 0, imgH),
    };
  }, [renderScale, imgW, imgH]);

  // Nearest handle within the (generous) hit radius — nearest wins so corners
  // are reliable even when edge handles are close by.
  const hitTestHandle = useCallback((ix: number, iy: number): HandleId | null => {
    if (!crop) return null;
    const hitR = HANDLE_HIT_PX / renderScale;
    let best: HandleId | null = null;
    let bestD = hitR;
    for (const [id, pos] of Object.entries(getHandles(crop)) as [HandleId, { x: number; y: number }][]) {
      const d = Math.hypot(ix - pos.x, iy - pos.y);
      if (d <= bestD) { bestD = d; best = id; }
    }
    return best;
  }, [crop, renderScale]);

  const isInsideBody = useCallback((ix: number, iy: number, b: CropBox) => {
    return ix >= b.x && ix <= b.x + b.w && iy >= b.y && iy <= b.y + b.h;
  }, []);

  const updateCursor = useCallback((ix: number, iy: number) => {
    if (!crop) { setCursor('crosshair'); return; }
    if (hitTestHandle(ix, iy)) { setCursor('pointer'); return; }
    if (isInsideBody(ix, iy, crop)) { setCursor('move'); return; }
    setCursor('crosshair');
  }, [crop, hitTestHandle, isInsideBody]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = getImageCoords(e);
    if (crop) {
      const h = hitTestHandle(x, y);
      if (h) { setDragState({ kind: 'resizing', handle: h, sx: x, sy: y, snap: { ...crop } }); return; }
      if (isInsideBody(x, y, crop)) { setDragState({ kind: 'moving', sx: x, sy: y, ox: crop.x, oy: crop.y }); return; }
    }
    setDragState({ kind: 'drawing', sx: x, sy: y });
    setCrop(null);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getImageCoords(e);
    if (dragState.kind !== 'none') e.preventDefault();
    updateCursor(x, y);
    if (dragState.kind === 'drawing') {
      const minX = Math.min(dragState.sx, x);
      const minY = Math.min(dragState.sy, y);
      setCrop({
        x: clamp(minX, 0, imgW), y: clamp(minY, 0, imgH),
        w: clamp(Math.abs(x - dragState.sx), 0, imgW - clamp(minX, 0, imgW)),
        h: clamp(Math.abs(y - dragState.sy), 0, imgH - clamp(minY, 0, imgH)),
      });
    } else if (dragState.kind === 'moving' && crop) {
      setCrop({ ...crop, x: clamp(dragState.ox + (x - dragState.sx), 0, imgW - crop.w), y: clamp(dragState.oy + (y - dragState.sy), 0, imgH - crop.h) });
    } else if (dragState.kind === 'resizing' && crop) {
      setCrop(resizeFromHandle(dragState.snap, dragState.handle, x - dragState.sx, y - dragState.sy, imgW, imgH));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* */ }
    setDragState({ kind: 'none' });
  };

  const detectBounds = () => {
    if (!img) return;
    const b = detectBoundingBox(img);
    if (b) setCrop({ x: b.x, y: b.y, w: b.width, h: b.height });
  };

  const resetToFull = () => {
    if (img) setCrop({ x: 0, y: 0, w: imgW, h: imgH });
  };

  const applyCrop = () => {
    if (!crop || !img || crop.w < 2 || crop.h < 2) return;
    const x = Math.round(crop.x), y = Math.round(crop.y);
    const w = Math.max(1, Math.round(crop.w)), h = Math.max(1, Math.round(crop.h));
    setPreviewData(cropImageData(img, x, y, w, h));
    setShowPreview(true);
  };

  useEffect(() => {
    if (!showPreview || !previewData || !previewCanvasRef.current) return;
    const c = previewCanvasRef.current;
    const maxPrev = 480;
    const s = Math.min(maxPrev / previewData.width, maxPrev / previewData.height, 1);
    c.width = Math.round(previewData.width * s);
    c.height = Math.round(previewData.height * s);
    c.style.width = c.width + 'px';
    c.style.height = c.height + 'px';
    const ctx = c.getContext('2d')!;
    const sz = 10;
    for (let py = 0; py < c.height; py += sz) {
      for (let px = 0; px < c.width; px += sz) {
        ctx.fillStyle = ((Math.floor(px / sz) + Math.floor(py / sz)) % 2 === 0) ? '#374151' : '#4b5563';
        ctx.fillRect(px, py, sz, sz);
      }
    }
    ctx.drawImage(imageDataToCanvas(previewData), 0, 0, c.width, c.height);
  }, [showPreview, previewData]);

  const confirmCrop = () => {
    if (!previewData) return;
    updateState({ croppedImage: previewData, currentStep: 2 });
    goToStep(2);
  };

  const skipCrop = () => {
    updateState({ croppedImage: img, currentStep: 2 });
    goToStep(2);
  };

  if (showPreview) {
    return (
      <div className="h-full flex flex-col gap-2.5">
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <canvas ref={previewCanvasRef} className="rounded" style={{ display: 'block' }} />
        </div>
        {previewData && (
          <p className="text-xs text-gray-500 text-center tabular-nums">
            {previewData.width} × {previewData.height} px
          </p>
        )}
        <div className="flex gap-2.5 shrink-0">
          <button onClick={() => setShowPreview(false)} className="flex-1 px-4 py-3.5 bg-gray-700 hover:bg-gray-600 rounded-xl transition font-semibold">
            Re-trim
          </button>
          <button onClick={confirmCrop} className="flex-1 px-4 py-3.5 bg-blue-600 hover:bg-blue-700 rounded-xl font-semibold transition">
            Looks Good
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col gap-2.5">
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={detectBounds} className="px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition">Auto-detect</button>
        <button onClick={resetToFull} className="px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition">Reset</button>
        <div className="flex-1" />
        {crop && (
          <span className="text-xs text-gray-500 tabular-nums">
            {Math.round(crop.w)} × {Math.round(crop.h)} px
          </span>
        )}
      </div>

      <div ref={wrapRef} className="flex-1 min-h-0 flex items-center justify-center">
        <canvas
          ref={canvasRef}
          style={{ cursor, display: 'block', touchAction: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>

      <div className="space-y-2 shrink-0">
        <button
          onClick={applyCrop}
          disabled={!crop || crop.w < 2 || crop.h < 2}
          className="w-full px-4 py-3.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl font-semibold transition"
        >
          Apply Trim
        </button>
        <button
          onClick={skipCrop}
          className="w-full py-1.5 text-xs text-gray-500 hover:text-gray-300 transition"
        >
          or skip — use the full image
        </button>
      </div>
    </div>
  );
}
