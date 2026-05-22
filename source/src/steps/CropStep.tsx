import { useState, useRef, useEffect, useCallback } from 'react';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
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

const HANDLE_RADIUS_PX = 6;
const HANDLE_HIT_PX = 12;
const MIN_DIM = 4;

const HANDLE_CURSORS: Record<HandleId, string> = {
  tl: 'nwse-resize', tc: 'ns-resize', tr: 'nesw-resize',
  ml: 'ew-resize', mr: 'ew-resize',
  bl: 'nesw-resize', bc: 'ns-resize', br: 'nwse-resize',
};

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
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number>(0);

  const img = state.sourceImage;
  const imgW = img?.width ?? 0;
  const imgH = img?.height ?? 0;

  const [crop, setCrop] = useState<CropBox | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dragState, setDragState] = useState<DragState>({ kind: 'none' });
  const [cursor, setCursor] = useState('default');
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState<ImageData | null>(null);

  const [containerW, setContainerW] = useState(700);
  const [containerH, setContainerH] = useState(440);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerW(entry.contentRect.width);
      setContainerH(entry.contentRect.height);
    });
    ro.observe(el);
    setContainerW(el.clientWidth);
    setContainerH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Fit the WHOLE image inside the container — both width and height — so the
  // trim screen never scrolls. Never up-scale above 1:1.
  const baseScale = imgW > 0 && imgH > 0
    ? Math.min((containerW - 8) / imgW, (containerH - 8) / imgH, 1)
    : 1;
  const renderScale = baseScale * zoom;

  useEffect(() => {
    if (img) srcCanvasRef.current = imageDataToCanvas(img);
  }, [img]);

  useEffect(() => {
    if (img && !crop) {
      setCrop({ x: 0, y: 0, w: imgW, h: imgH });
    }
  }, [img, imgW, imgH]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const src = srcCanvasRef.current;
    if (!canvas || !src || !img) return;

    const rs = renderScale;
    const cssW = Math.round(imgW * rs);
    const cssH = Math.round(imgH * rs);
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
    // All drawing below works in CSS-pixel coordinates thanks to this scale —
    // the higher-density buffer makes everything crisp on retina.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(src, 0, 0, cssW, cssH);

    const currentCrop = crop;
    if (currentCrop) {
      const { x, y, w, h } = currentCrop;
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

      const handles = getHandles(currentCrop);
      Object.values(handles).forEach(({ x: hx, y: hy }) => {
        // Inset the drawn circle by its radius so handles sitting on the
        // image edge (x=0, y=0, x=imgW, y=imgH) aren't clipped in half.
        const cx = clamp(hx * rs, HANDLE_RADIUS_PX, cssW - HANDLE_RADIUS_PX);
        const cy = clamp(hy * rs, HANDLE_RADIUS_PX, cssH - HANDLE_RADIUS_PX);
        ctx.beginPath();
        ctx.arc(cx, cy, HANDLE_RADIUS_PX, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
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

  const hitTestHandle = useCallback((ix: number, iy: number): HandleId | null => {
    if (!crop) return null;
    const hitR = HANDLE_HIT_PX / renderScale;
    for (const [id, pos] of Object.entries(getHandles(crop)) as [HandleId, { x: number; y: number }][]) {
      if (Math.abs(ix - pos.x) <= hitR && Math.abs(iy - pos.y) <= hitR) return id;
    }
    return null;
  }, [crop, renderScale]);

  const isInsideBody = useCallback((ix: number, iy: number, box: CropBox) => {
    const hitR = HANDLE_HIT_PX / renderScale;
    for (const pos of Object.values(getHandles(box))) {
      if (Math.abs(ix - pos.x) <= hitR && Math.abs(iy - pos.y) <= hitR) return false;
    }
    return ix >= box.x && ix <= box.x + box.w && iy >= box.y && iy <= box.y + box.h;
  }, [renderScale]);

  const updateCursor = useCallback((ix: number, iy: number) => {
    if (!crop) { setCursor('crosshair'); return; }
    const h = hitTestHandle(ix, iy);
    if (h) { setCursor(HANDLE_CURSORS[h]); return; }
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
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
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
    const cropped = cropImageData(img, x, y, w, h);
    setPreviewData(cropped);
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
    const tmp = imageDataToCanvas(previewData);
    ctx.drawImage(tmp, 0, 0, c.width, c.height);
  }, [showPreview, previewData]);

  const confirmCrop = () => {
    if (!previewData) return;
    updateState({ croppedImage: previewData, currentStep: 3 });
    goToStep(3);
  };

  const skipCrop = () => {
    updateState({ croppedImage: img, currentStep: 3 });
    goToStep(3);
  };

  return (
    <div className="space-y-2.5">
      {!showPreview ? (
        <>
          <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2 flex-wrap">
            <button onClick={detectBounds} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm transition">Auto</button>
            <button onClick={resetToFull} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm transition">Reset</button>
            <div className="w-px h-5 bg-gray-600 mx-1" />
            <button onClick={() => setZoom(z => Math.max(z / 1.5, 0.2))} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" title="Zoom out"><ZoomOut size={16} /></button>
            <span className="text-xs text-gray-400 w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(z * 1.5, 8))} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" title="Zoom in"><ZoomIn size={16} /></button>
            <button onClick={() => setZoom(1)} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" title="Reset zoom"><RotateCcw size={14} /></button>
            <div className="flex-1" />
            {crop && (
              <span className="text-xs text-gray-500 tabular-nums">
                {Math.round(crop.w)} × {Math.round(crop.h)} px
              </span>
            )}
          </div>

          <div
            ref={containerRef}
            className="rounded-lg border border-gray-700 bg-gray-950 flex items-center justify-center overflow-hidden"
            style={{ height: 'calc(100dvh - 250px)', minHeight: '260px' }}
          >
            <canvas
              ref={canvasRef}
              style={{ cursor, display: 'block', touchAction: 'none' }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={applyCrop}
              disabled={!crop || crop.w < 2 || crop.h < 2}
              className="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg font-semibold transition text-sm"
            >
              Apply Trim
            </button>
            <button onClick={skipCrop} className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg transition text-sm font-semibold">
              Skip — Use Full Image
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <div className="bg-gray-800 rounded-lg p-4 space-y-3">
            <h3 className="font-semibold text-sm text-gray-300">Result — does this look right?</h3>
            <div className="overflow-auto flex justify-center bg-gray-900 rounded-lg p-4" style={{ maxHeight: '58vh' }}>
              <canvas ref={previewCanvasRef} className="rounded" style={{ display: 'block' }} />
            </div>
            {previewData && (
              <p className="text-xs text-gray-500 text-center tabular-nums">
                {previewData.width} × {previewData.height} px
              </p>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={() => setShowPreview(false)} className="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition text-sm font-semibold">
              Re-trim
            </button>
            <button onClick={confirmCrop} className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold transition text-sm">
              Looks Good — Continue
            </button>
          </div>
        </div>
      )}
    </div>
  );
}