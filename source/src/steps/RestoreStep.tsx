import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, Maximize2, Sparkles } from 'lucide-react';
import { AppState } from '../App';
import { cloneImageData, get2dContext } from '../utils/imageUtils';
import { analyzeSpecks, speckIds, removeSpecks, SpeckAnalysis } from '../utils/dotCleanup';

type Tool = 'restore' | 'erase' | 'none';
type BgMode = 'checker' | 'white' | 'black' | 'custom';

type Props = {
  state: AppState;
  updateState: (updates: Partial<AppState>) => void;
  goToStep: (step: number) => void;
};

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

export default function RestoreStep({ state, updateState, goToStep }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const workingRef = useRef<ImageData | null>(null);
  const sourceRef = useRef<ImageData | null>(null);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  // Cached offscreen canvases — the bg pattern and the working image stay
  // resident so paint strokes only need to composite, not regenerate.
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgKeyRef = useRef<string>('');
  const workingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workingCacheIdRef = useRef<ImageData | null>(null);
  const fullyDrawnRef = useRef(false);

  const [workingData, setWorkingData] = useState<ImageData | null>(() =>
    state.canvasData ? cloneImageData(state.canvasData) : null
  );
  const [currentTool, setCurrentTool] = useState<Tool>('none');
  const [brushSize, setBrushSize] = useState(20);
  const [brushStrength, setBrushStrength] = useState(80);
  const [brushHardness, setBrushHardness] = useState(60);
  const [zoom, setZoom] = useState(1);
  const [bgMode, setBgMode] = useState<BgMode>('checker');
  const [customBgColor, setCustomBgColor] = useState('#888888');
  const [undoStack, setUndoStack] = useState<ImageData[]>([]);
  const [containerW, setContainerW] = useState(700);
  const [containerH, setContainerH] = useState(500);
  const [cursorPos, setCursorPos] = useState<{ cx: number; cy: number } | null>(null);

  // Dot Cleanup — auto-removal of tiny floating specks.
  const [dotPanel, setDotPanel] = useState(false);
  const [dotAnalyzing, setDotAnalyzing] = useState(false);
  const [speckAnalysis, setSpeckAnalysis] = useState<SpeckAnalysis | null>(null);
  const [dotThreshold, setDotThreshold] = useState(150);

  const imgW = workingData?.width ?? 0;
  const imgH = workingData?.height ?? 0;

  // Fit the working canvas within the container at zoom=1, capped at 1× CSS-px
  // so we never upscale a small image past its native res.
  const baseScale = imgW > 0
    ? Math.min((containerW - 8) / imgW, (containerH - 8) / imgH, 1)
    : 1;
  const renderScale = baseScale * zoom;

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

  useEffect(() => {
    if (state.canvasData) {
      const clone = cloneImageData(state.canvasData);
      workingRef.current = clone;
      setWorkingData(clone);
    }
    // RestoreStep needs the platen-sized canvas BEFORE alpha removal —
    // that's the source the restore brush brings back from.
    // state.sourceImage is the original ungraded graphic (wrong dimensions);
    // state.prealphaCanvas is the platen-positioned RGBA snapshot taken in AlphaStep.proceed().
    if (state.prealphaCanvas) {
      sourceRef.current = state.prealphaCanvas;
    } else if (state.sourceImage) {
      sourceRef.current = state.sourceImage;
    }
  }, []);

  // Build (or reuse) the offscreen bg canvas at backing-store resolution.
  // Cache-keyed on bgMode + customColor + size — regenerated only when those
  // actually change, NOT on every brush stroke.
  const getBgCanvas = useCallback((bw: number, bh: number) => {
    const key = `${bgMode}|${customBgColor}|${bw}x${bh}`;
    if (bgCanvasRef.current && bgKeyRef.current === key) return bgCanvasRef.current;

    const c = bgCanvasRef.current ?? document.createElement('canvas');
    c.width = bw;
    c.height = bh;
    const ctx = get2dContext(c);

    if (bgMode === 'checker') {
      // Build a small repeating tile, then fill with it — orders of magnitude
      // faster than the per-cell fillRect loop.
      const tile = document.createElement('canvas');
      const tileSz = 20;
      tile.width = tileSz;
      tile.height = tileSz;
      const tctx = get2dContext(tile);
      tctx.fillStyle = '#374151';
      tctx.fillRect(0, 0, 10, 10);
      tctx.fillRect(10, 10, 10, 10);
      tctx.fillStyle = '#4b5563';
      tctx.fillRect(10, 0, 10, 10);
      tctx.fillRect(0, 10, 10, 10);
      const pattern = ctx.createPattern(tile, 'repeat');
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, bw, bh);
      }
    } else {
      ctx.fillStyle = bgMode === 'white' ? '#ffffff' : bgMode === 'black' ? '#000000' : customBgColor;
      ctx.fillRect(0, 0, bw, bh);
    }

    bgCanvasRef.current = c;
    bgKeyRef.current = key;
    return c;
  }, [bgMode, customBgColor]);

  // Working-image offscreen canvas at NATIVE image resolution. Reused across
  // strokes; we only resync the dirty subrect when a stroke modifies pixels.
  const getWorkingCanvas = useCallback((data: ImageData, dirty?: { x: number; y: number; w: number; h: number }) => {
    let c = workingCanvasRef.current;
    const needsResize = !c || c.width !== data.width || c.height !== data.height;
    if (needsResize) {
      c = document.createElement('canvas');
      c.width = data.width;
      c.height = data.height;
      workingCanvasRef.current = c;
      get2dContext(c).putImageData(data, 0, 0);
      workingCacheIdRef.current = data;
    } else if (workingCacheIdRef.current !== data && !dirty) {
      // Whole-data replacement (undo, initial entry) — full sync.
      get2dContext(c!).putImageData(data, 0, 0);
      workingCacheIdRef.current = data;
    } else if (dirty) {
      // Same ImageData buffer, modified in place by paintAt. Sync just the
      // dirty subrect to keep this cheap during scrubbing.
      get2dContext(c!).putImageData(data, 0, 0, dirty.x, dirty.y, dirty.w, dirty.h);
      workingCacheIdRef.current = data;
    }
    return c!;
  }, []);

  const redraw = useCallback((
    data: ImageData | null = workingRef.current,
    dirty?: { x: number; y: number; w: number; h: number }
  ) => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;

    const cssW = Math.round(data.width * renderScale);
    const cssH = Math.round(data.height * renderScale);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);

    const resized = canvas.width !== bw || canvas.height !== bh;
    if (resized) {
      canvas.width = bw;
      canvas.height = bh;
      fullyDrawnRef.current = false;
    }
    if (canvas.style.width !== cssW + 'px' || canvas.style.height !== cssH + 'px') {
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
    }

    const ctx = get2dContext(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const bg = getBgCanvas(bw, bh);
    const work = getWorkingCanvas(data, dirty);

    // Partial path: only valid if we already have a complete frame on screen
    // AND a dirty rect was provided. Composite only that region.
    if (dirty && fullyDrawnRef.current && !resized) {
      const dx = dirty.x * renderScale;
      const dy = dirty.y * renderScale;
      const dw = dirty.w * renderScale;
      const dh = dirty.h * renderScale;
      // Bg subrect — bg is at backing-store scale, so source coords scale by dpr.
      ctx.drawImage(bg, dx * dpr, dy * dpr, dw * dpr, dh * dpr, dx, dy, dw, dh);
      ctx.drawImage(work, dirty.x, dirty.y, dirty.w, dirty.h, dx, dy, dw, dh);
      return;
    }

    // Full redraw — initial mount, mode change, zoom change, resize, undo.
    ctx.drawImage(bg, 0, 0, bw, bh, 0, 0, cssW, cssH);
    ctx.drawImage(work, 0, 0, cssW, cssH);
    fullyDrawnRef.current = true;
  }, [renderScale, getBgCanvas, getWorkingCanvas]);

  useEffect(() => {
    redraw(workingData);
  }, [redraw, workingData]);

  const getImageCoords = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clamp((e.clientX - rect.left) / renderScale, 0, imgW - 1),
      y: clamp((e.clientY - rect.top) / renderScale, 0, imgH - 1),
    };
  }, [renderScale, imgW, imgH]);

  // Precomputed circular brush mask. Each cell holds the falloff multiplier
  // (0..1) for that offset from the brush center; cells outside the disk
  // stay at 0 and the inner loop skips them via a single comparison instead
  // of recomputing sqrt + the hardness ramp per pixel per dab.
  //
  // Recomputed only when brushSize or brushHardness changes. Worst case
  // (size 150) is a 301×301 Float32Array ≈ 360 KB — fine.
  const brushMask = useMemo(() => {
    const r = brushSize;
    const stride = 2 * r + 1;
    const innerR = r * (brushHardness / 100);
    const ramp = Math.max(r - innerR, 1);
    const m = new Float32Array(stride * stride);
    for (let dy = -r; dy <= r; dy++) {
      const rowBase = (dy + r) * stride;
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r) continue;
        m[rowBase + (dx + r)] = dist <= innerR ? 1 : 1 - (dist - innerR) / ramp;
      }
    }
    return { data: m, stride, r };
  }, [brushSize, brushHardness]);

  const paintAt = useCallback((cx: number, cy: number) => {
    const data = workingRef.current;
    if (!data || currentTool === 'none') return;
    const d = data.data;
    const w = data.width;
    const h = data.height;
    const src = sourceRef.current;
    const srcMatches = src && src.width === w && src.height === h;
    const srcData = srcMatches && src ? src.data : null;
    const strength255 = brushStrength * 2.55; // 255 * (brushStrength / 100)
    const { data: mask, stride, r } = brushMask;

    // Tighten loop bounds so we never iterate cells that fall outside the
    // image — replaces the per-pixel bounds check.
    const cxRound = Math.round(cx);
    const cyRound = Math.round(cy);
    const xMin = Math.max(-r, -cxRound);
    const xMax = Math.min(r, w - 1 - cxRound);
    const yMin = Math.max(-r, -cyRound);
    const yMax = Math.min(r, h - 1 - cyRound);

    for (let dy = yMin; dy <= yMax; dy++) {
      const my = dy + r;
      const maskRow = my * stride;
      const pyRow = (cyRound + dy) * w;
      for (let dx = xMin; dx <= xMax; dx++) {
        const falloff = mask[maskRow + (dx + r)];
        if (falloff <= 0) continue;
        const idx = (pyRow + cxRound + dx) * 4;

        if (currentTool === 'erase') {
          const sub = (strength255 * falloff + 0.5) | 0; // round
          const cur = d[idx + 3];
          d[idx + 3] = cur > sub ? cur - sub : 0;
        } else if (srcData) {
          const amt = (strength255 * falloff + 0.5) | 0;
          const cur = d[idx + 3];
          const newAlpha = cur + amt > 255 ? 255 : cur + amt;
          if (newAlpha > cur) {
            const t = (newAlpha - cur) / 255;
            const inv = 1 - t;
            d[idx]     = (d[idx]     * inv + srcData[idx]     * t + 0.5) | 0;
            d[idx + 1] = (d[idx + 1] * inv + srcData[idx + 1] * t + 0.5) | 0;
            d[idx + 2] = (d[idx + 2] * inv + srcData[idx + 2] * t + 0.5) | 0;
            d[idx + 3] = newAlpha;
          }
        }
      }
    }

    // Tight dirty rect clamped to image bounds — redraw composites only
    // this region instead of repainting the whole canvas.
    const dxMin = Math.max(0, cxRound - r);
    const dyMin = Math.max(0, cyRound - r);
    const dxMax = Math.min(w - 1, cxRound + r);
    const dyMax = Math.min(h - 1, cyRound + r);
    if (dxMax >= dxMin && dyMax >= dyMin) {
      redraw(data, { x: dxMin, y: dyMin, w: dxMax - dxMin + 1, h: dyMax - dyMin + 1 });
    }
  }, [currentTool, brushStrength, brushMask, redraw]);

  // Track CSS-pixel cursor position over the canvas so the brush-size ring
  // can follow the finger (which otherwise covers the actual touch point).
  const updateCursor = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCursorPos({ cx: e.clientX - rect.left, cy: e.clientY - rect.top });
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (currentTool === 'none') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;
    if (workingRef.current) {
      setUndoStack(prev => [...prev.slice(-19), cloneImageData(workingRef.current!)]);
    }
    updateCursor(e);
    const { x, y } = getImageCoords(e);
    lastPosRef.current = { x, y };
    paintAt(x, y);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    updateCursor(e);
    if (!isDrawingRef.current) return;
    e.preventDefault();
    const { x, y } = getImageCoords(e);
    const last = lastPosRef.current;
    if (last) {
      const steps = Math.max(1, Math.ceil(Math.sqrt((x - last.x) ** 2 + (y - last.y) ** 2) / (brushSize * 0.3)));
      for (let i = 1; i <= steps; i++) {
        paintAt(last.x + (x - last.x) * i / steps, last.y + (y - last.y) * i / steps);
      }
    } else {
      paintAt(x, y);
    }
    lastPosRef.current = { x, y };
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPosRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    if (workingRef.current) {
      setWorkingData(cloneImageData(workingRef.current));
    }
  };

  const undo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    const restored = cloneImageData(prev);
    workingRef.current = restored;
    setWorkingData(restored);
    setUndoStack(s => s.slice(0, -1));
  };

  const fitToScreen = () => setZoom(1);

  // --- Dot Cleanup ----------------------------------------------------------
  const openDotCleanup = () => {
    const data = workingRef.current ?? workingData;
    if (!data) return;
    setCurrentTool('none');
    setDotPanel(true);
    setDotAnalyzing(true);
    setSpeckAnalysis(null);
    // Let the spinner paint before the (blocking) connected-component pass.
    setTimeout(() => {
      const a = analyzeSpecks(data);
      setSpeckAnalysis(a);
      setDotAnalyzing(false);
    }, 30);
  };

  const closeDotCleanup = () => {
    setDotPanel(false);
    setSpeckAnalysis(null);
    setDotAnalyzing(false);
  };

  const applyDotCleanup = () => {
    const data = workingRef.current ?? workingData;
    if (!data || !speckAnalysis) return;
    const cleaned = removeSpecks(data, speckAnalysis, dotThreshold);
    setUndoStack(prev => [...prev.slice(-19), cloneImageData(data)]);
    workingRef.current = cleaned;
    setWorkingData(cleaned);
    closeDotCleanup();
  };

  const speckList = speckAnalysis ? speckIds(speckAnalysis, dotThreshold) : [];

  const proceed = () => {
    const data = workingRef.current ?? workingData;
    if (data) {
      updateState({ canvasData: data, currentStep: 6 });
      goToStep(6);
    }
  };

  const toolActive = currentTool !== 'none';
  const cursorRingDiameter = brushSize * 2 * renderScale;

  return (
    <div className="space-y-3">
      <div className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-start">
        <div className="flex-1 space-y-3 min-w-0">
          <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2 flex-wrap">
            <span className="text-xs text-gray-400 font-medium">Background:</span>
            {(['checker', 'white', 'black', 'custom'] as BgMode[]).map(m => (
              <button
                key={m}
                onClick={() => setBgMode(m)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition ${bgMode === m ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}
              >
                {m === 'checker' && <span className="w-3 h-3 rounded-sm" style={{ background: 'repeating-conic-gradient(#888 0% 25%, #555 0% 50%) 0 0 / 6px 6px' }} />}
                {m === 'white' && <span className="w-3 h-3 rounded-sm border border-gray-500 bg-white" />}
                {m === 'black' && <span className="w-3 h-3 rounded-sm bg-black border border-gray-500" />}
                {m === 'custom' && <span className="w-3 h-3 rounded-sm border border-gray-500" style={{ background: customBgColor }} />}
                {m === 'checker' ? 'Transparent' : m === 'white' ? 'White' : m === 'black' ? 'Black' : 'Custom'}
              </button>
            ))}
            {bgMode === 'custom' && (
              <input type="color" value={customBgColor} onChange={e => setCustomBgColor(e.target.value)} className="w-8 h-7 rounded cursor-pointer bg-transparent border-0" />
            )}
            <div className="w-px h-5 bg-gray-600 mx-1" />
            <button onClick={() => setZoom(z => Math.max(z / 1.5, 0.2))} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" aria-label="Zoom out"><ZoomOut size={15} /></button>
            <span className="text-xs text-gray-400 w-11 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(z * 1.5, 6))} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" aria-label="Zoom in"><ZoomIn size={15} /></button>
            <button onClick={() => setZoom(1)} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" aria-label="Reset zoom"><RotateCcw size={13} /></button>
            <button onClick={fitToScreen} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" aria-label="Fit to screen"><Maximize2 size={13} /></button>
          </div>

          <div
            ref={containerRef}
            className="overflow-auto rounded-lg border border-gray-700 relative"
            style={{ maxHeight: '65vh', minHeight: '300px' }}
            onPointerLeave={() => setCursorPos(null)}
          >
            <canvas
              ref={canvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              style={{
                display: 'block',
                cursor: toolActive ? 'none' : 'default',
                touchAction: toolActive ? 'none' : 'auto',
              }}
            />
            {/* Brush-size ring follows the pointer so the finger isn't covering
                the active brush radius. Two-tone outline stays visible over
                both light and dark backgrounds. */}
            {toolActive && cursorPos && cursorRingDiameter > 4 && (
              <div
                className="pointer-events-none absolute rounded-full"
                style={{
                  left: cursorPos.cx - cursorRingDiameter / 2,
                  top: cursorPos.cy - cursorRingDiameter / 2,
                  width: cursorRingDiameter,
                  height: cursorRingDiameter,
                  border: '2px solid rgba(255,255,255,0.9)',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.7), inset 0 0 0 1px rgba(0,0,0,0.7)',
                }}
              />
            )}
            {/* Dot Cleanup — red rings mark every speck that will be removed. */}
            {dotPanel && speckAnalysis && speckList.slice(0, 250).map((id) => {
              const s = speckAnalysis.spots[id];
              const d = Math.max(14, s.r * 2 * renderScale + 10);
              return (
                <div
                  key={id}
                  className="pointer-events-none absolute rounded-full"
                  style={{
                    left: s.cx * renderScale - d / 2,
                    top: s.cy * renderScale - d / 2,
                    width: d,
                    height: d,
                    border: '2px solid rgba(248,113,113,0.95)',
                    boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
                  }}
                />
              );
            })}
          </div>
        </div>

        <div className="w-full lg:w-60 lg:shrink-0 space-y-3">
          {dotPanel ? (
            <div className="bg-gray-800 p-4 rounded-lg space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-blue-400" />
                <span className="font-semibold">Dot Cleanup</span>
              </div>
              {dotAnalyzing ? (
                <p className="text-sm text-gray-400 py-6 text-center">Scanning for specks…</p>
              ) : speckAnalysis ? (
                <>
                  <p className="text-xs text-gray-400 leading-snug">
                    Red rings mark every floating speck that will be removed. Drag
                    to set the largest speck size to clear — your main artwork is
                    always kept.
                  </p>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-medium">Speck size</label>
                      <span className="font-mono text-blue-400 text-sm">&le; {dotThreshold} px</span>
                    </div>
                    <input
                      type="range" min="0" max="1200" step="10" value={dotThreshold}
                      onChange={e => setDotThreshold(parseInt(e.target.value))}
                      className="w-full accent-blue-500"
                    />
                  </div>
                  <p className="text-sm">
                    <span className="font-semibold text-red-300">{speckList.length}</span>
                    <span className="text-gray-400"> speck{speckList.length === 1 ? '' : 's'} will be removed</span>
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={closeDotCleanup}
                      className="flex-1 px-3 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-semibold transition"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={applyDotCleanup}
                      disabled={speckList.length === 0}
                      className="flex-1 px-3 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg text-sm font-semibold transition"
                    >
                      Remove {speckList.length}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <>
              <div className="bg-gray-800 p-4 rounded-lg space-y-3">
                <div>
                  <label className="text-xs text-gray-400 font-medium block mb-2">Active Tool</label>
                  <div className="grid grid-cols-1 gap-1.5">
                    <button
                      onClick={() => setCurrentTool(t => t === 'restore' ? 'none' : 'restore')}
                      className={`px-3 py-2.5 rounded-lg text-sm font-semibold transition flex items-center gap-2 ${currentTool === 'restore' ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}
                    >
                      <span>{currentTool === 'restore' ? 'Restore (Active)' : 'Restore Brush'}</span>
                    </button>
                    <button
                      onClick={() => setCurrentTool(t => t === 'erase' ? 'none' : 'erase')}
                      className={`px-3 py-2.5 rounded-lg text-sm font-semibold transition flex items-center gap-2 ${currentTool === 'erase' ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}
                    >
                      <span>{currentTool === 'erase' ? 'Eraser (Active)' : 'Erase Brush'}</span>
                    </button>
                    {currentTool !== 'none' && (
                      <button onClick={() => setCurrentTool('none')} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs text-gray-400 transition">
                        Deactivate Tool
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium block mb-1">
                    Brush Size <span className="font-mono text-blue-400 ml-1">{brushSize}px</span>
                  </label>
                  <input type="range" min="1" max="150" value={brushSize} onChange={e => setBrushSize(parseInt(e.target.value))} className="w-full accent-blue-500" />
                </div>

                <div>
                  <label className="text-sm font-medium block mb-1">
                    Strength <span className="font-mono text-blue-400 ml-1">{brushStrength}%</span>
                  </label>
                  <input type="range" min="1" max="100" value={brushStrength} onChange={e => setBrushStrength(parseInt(e.target.value))} className="w-full accent-blue-500" />
                </div>

                <div>
                  <label className="text-sm font-medium block mb-1">
                    Hardness <span className="font-mono text-blue-400 ml-1">{brushHardness}%</span>
                  </label>
                  <input type="range" min="0" max="100" value={brushHardness} onChange={e => setBrushHardness(parseInt(e.target.value))} className="w-full accent-blue-500" />
                </div>
              </div>

              <button
                onClick={openDotCleanup}
                className="w-full flex items-center justify-center gap-2 px-3 py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm font-semibold transition"
              >
                <Sparkles size={15} className="text-blue-400" />
                Clean Dots
              </button>

              <div className="flex gap-2">
                <button
                  onClick={undo}
                  disabled={undoStack.length === 0}
                  className="flex-1 px-3 py-2.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm transition"
                >
                  Undo ({undoStack.length})
                </button>
                <button onClick={proceed} className="flex-1 px-3 py-2.5 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold transition">
                  Continue
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
