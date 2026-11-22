import { useState, useRef, useEffect, useCallback } from 'react';
import { AppState } from '../App';
import { lanczosResize, imageDataToCanvas } from '../utils/imageUtils';

const TEMPLATES = [
  { name: 'Neato Regular', short: 'Neato Reg',   label: '12"×16"', width: 3600, height: 4800 },
  { name: 'Neato Jumbo',   short: 'Neato Jumbo', label: '15"×18"', width: 4500, height: 5400 },
  { name: 'P-Partner Regular',   short: 'P-Partner',     label: '16"×21"', width: 4800, height: 6300 },
  { name: 'P-Partner MAX',       short: 'P-Partner MAX', label: '20"×20"', width: 6000, height: 6000 },
];
const DEFAULT_TEMPLATE = 1; // Neato Jumbo
// Largest real dimension across all platens — used to size the proportional
// preview chips so Reg visibly reads smaller than Jumbo, etc.
const MAX_TEMPLATE_DIM = Math.max(...TEMPLATES.flatMap(t => [t.width, t.height]));

type Props = {
  state: AppState;
  updateState: (updates: Partial<AppState>) => void;
  goToStep: (step: number) => void;
};

type Preset = 'fit' | 'actual' | 'fill' | 'custom';
type Corner = 'tl' | 'tr' | 'bl' | 'br';
type Interaction =
  | { kind: 'none' }
  | { kind: 'move'; px: number; py: number; ox: number; oy: number }
  | { kind: 'resize'; corner: Corner; ax: number; ay: number };

const HANDLE_R = 10;
const HANDLE_HIT = 28;
const MARGIN = 28; // gutter around the platen so the canvas edge is clearly
                   // visible and artwork crossing it is obvious

function drawCheckerboard(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const sz = 12;
  for (let y = 0; y < h; y += sz) {
    for (let x = 0; x < w; x += sz) {
      ctx.fillStyle = ((Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0) ? '#374151' : '#4b5563';
      ctx.fillRect(x, y, sz, sz);
    }
  }
}

export default function PlatenStep({ state, updateState, goToStep }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const src = state.croppedImage;
  const srcW = src?.width ?? 0;
  const srcH = src?.height ?? 0;

  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [platen, setPlaten] = useState<{ width: number; height: number } | null>(null);
  const [preset, setPreset] = useState<Preset>('fit');

  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const [displayScale, setDisplayScale] = useState(1);
  const [box, setBox] = useState({ w: 340, h: 420 });
  const [interaction, setInteraction] = useState<Interaction>({ kind: 'none' });
  const [snapH, setSnapH] = useState<'left' | 'center' | 'right' | null>(null);
  const [snapV, setSnapV] = useState<'top' | 'center' | 'bottom' | null>(null);
  const [rendering, setRendering] = useState(false);
  const didInit = useRef(false);

  useEffect(() => {
    if (!src) return;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d')!.putImageData(src, 0, 0);
    srcCanvasRef.current = c;
  }, [src]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!platen) return;
    const availW = Math.max(box.w - 2 * MARGIN - 4, 140);
    const availH = Math.max(box.h - 2 * MARGIN - 4, 140);
    setDisplayScale(Math.min(availW / platen.width, availH / platen.height));
  }, [platen, box]);

  // --- Placement presets ----------------------------------------------------
  const placeFit = useCallback((d: { width: number; height: number }) => {
    const s = Math.min(d.width / srcW, d.height / srcH);
    setScale(s);
    setPos({ x: (d.width - srcW * s) / 2, y: 0 });
  }, [srcW, srcH]);

  const placeActual = useCallback((d: { width: number; height: number }) => {
    setScale(1);
    setPos({ x: (d.width - srcW) / 2, y: (d.height - srcH) / 2 });
  }, [srcW, srcH]);

  const placeFill = useCallback((d: { width: number; height: number }) => {
    const s = Math.max(d.width / srcW, d.height / srcH);
    setScale(s);
    setPos({ x: (d.width - srcW * s) / 2, y: (d.height - srcH * s) / 2 });
  }, [srcW, srcH]);

  const applyPreset = (p: Exclude<Preset, 'custom'>, d = platen) => {
    if (!d) return;
    setPreset(p);
    if (p === 'fit') placeFit(d);
    else if (p === 'actual') placeActual(d);
    else placeFill(d);
  };

  useEffect(() => {
    if (didInit.current || !src) return;
    didInit.current = true;
    const carried = TEMPLATES.find(t => t.name === state.platenName);
    const t = carried ?? TEMPLATES[DEFAULT_TEMPLATE];
    const d = { width: t.width, height: t.height };
    setPlaten(d);
    setSelectedTemplate(t.name);
    placeFit(d);
  }, [src, state.platenName, placeFit]);

  const selectTemplate = (t: typeof TEMPLATES[0]) => {
    const d = { width: t.width, height: t.height };
    setPlaten(d);
    setSelectedTemplate(t.name);
    updateState({ platenDimensions: d, platenName: t.name });
    if (preset === 'actual') placeActual(d);
    else if (preset === 'fill') placeFill(d);
    else placeFit(d);
  };

  const dispW = srcW * scale;
  const dispH = srcH * scale;
  const minScale = srcW > 0 ? Math.max(0.04, 120 / Math.max(srcW, srcH)) : 0.04;
  const maxScale = platen ? Math.max(platen.width / srcW, platen.height / srcH) * 3 : 8;

  const offEdge = !!platen && (
    pos.x < -1 || pos.y < -1 ||
    pos.x + dispW > platen.width + 1 ||
    pos.y + dispH > platen.height + 1
  );

  const cornerPoints = useCallback((): Record<Corner, { x: number; y: number }> => ({
    tl: { x: pos.x,         y: pos.y },
    tr: { x: pos.x + dispW, y: pos.y },
    bl: { x: pos.x,         y: pos.y + dispH },
    br: { x: pos.x + dispW, y: pos.y + dispH },
  }), [pos, dispW, dispH]);

  // --- Draw -----------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const sc = srcCanvasRef.current;
    if (!canvas || !sc || !platen) return;

    const rs = displayScale;
    const pw = platen.width * rs;          // platen area, CSS px
    const ph = platen.height * rs;
    const cssW = pw + 2 * MARGIN;
    const cssH = ph + 2 * MARGIN;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    const ctx = canvas.getContext('2d')!;
    // High-DPI backing store + a margin so nothing on the platen edge clips.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.translate(MARGIN, MARGIN);

    drawCheckerboard(ctx, pw, ph);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sc, pos.x * rs, pos.y * rs, dispW * rs, dispH * rs);

    // Snap guide lines.
    ctx.strokeStyle = 'rgba(96,165,250,0.95)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    if (snapH) {
      const gx = snapH === 'left' ? 0 : snapH === 'right' ? pw : pw / 2;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, ph); ctx.stroke();
    }
    if (snapV) {
      const gy = snapV === 'top' ? 0 : snapV === 'bottom' ? ph : ph / 2;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(pw, gy); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Image outline — red when it spills past the platen edge.
    ctx.strokeStyle = offEdge ? '#f87171' : '#60a5fa';
    ctx.lineWidth = 2;
    ctx.strokeRect(pos.x * rs, pos.y * rs, dispW * rs, dispH * rs);

    // Corner handles, clamped to the platen so they stay visible + tappable.
    const pts = cornerPoints();
    (Object.keys(pts) as Corner[]).forEach((c) => {
      const cx = Math.min(Math.max(pts[c].x * rs, HANDLE_R), pw - HANDLE_R);
      const cy = Math.min(Math.max(pts[c].y * rs, HANDLE_R), ph - HANDLE_R);
      ctx.beginPath();
      ctx.arc(cx, cy, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    });

    // Platen edge — the canvas boundary. Bright with a soft dark shadow so it
    // stays clearly readable over any artwork or the checkerboard, instead of
    // the near-invisible dark-grey line it used to be.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, pw, ph);
    ctx.restore();
  }, [platen, displayScale, pos, dispW, dispH, snapH, snapV, offEdge, cornerPoints]);

  // --- Pointer interaction --------------------------------------------------
  const toPlaten = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - MARGIN) / displayScale,
      y: (e.clientY - rect.top - MARGIN) / displayScale,
    };
  };

  const hitCorner = (x: number, y: number): Corner | null => {
    const pts = cornerPoints();
    const r = HANDLE_HIT / displayScale;
    let best: Corner | null = null;
    let bestD = r;
    for (const c of Object.keys(pts) as Corner[]) {
      const d = Math.hypot(pts[c].x - x, pts[c].y - y);
      if (d <= bestD) { bestD = d; best = c; }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!platen || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = toPlaten(e);

    const corner = hitCorner(x, y);
    if (corner) {
      const pts = cornerPoints();
      const opp: Record<Corner, Corner> = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };
      const a = pts[opp[corner]];
      setInteraction({ kind: 'resize', corner, ax: a.x, ay: a.y });
      return;
    }
    if (x >= pos.x && x <= pos.x + dispW && y >= pos.y && y <= pos.y + dispH) {
      setInteraction({ kind: 'move', px: x, py: y, ox: pos.x, oy: pos.y });
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (interaction.kind === 'none' || !platen) return;
    e.preventDefault();
    const { x, y } = toPlaten(e);
    const snapPx = Math.max(28, Math.min(platen.width, platen.height) * 0.022);

    if (interaction.kind === 'move') {
      let nx = interaction.ox + (x - interaction.px);
      let ny = interaction.oy + (y - interaction.py);
      const cx = (platen.width - dispW) / 2;
      const cy = (platen.height - dispH) / 2;
      let sh: typeof snapH = null;
      let sv: typeof snapV = null;
      if (Math.abs(nx) < snapPx) { nx = 0; sh = 'left'; }
      else if (Math.abs(nx - cx) < snapPx) { nx = cx; sh = 'center'; }
      else if (Math.abs(nx - (platen.width - dispW)) < snapPx) { nx = platen.width - dispW; sh = 'right'; }
      if (Math.abs(ny) < snapPx) { ny = 0; sv = 'top'; }
      else if (Math.abs(ny - cy) < snapPx) { ny = cy; sv = 'center'; }
      else if (Math.abs(ny - (platen.height - dispH)) < snapPx) { ny = platen.height - dispH; sv = 'bottom'; }
      setSnapH(sh);
      setSnapV(sv);
      setPos({ x: nx, y: ny });
      setPreset('custom');
      return;
    }

    if (interaction.kind === 'resize') {
      const { corner, ax, ay } = interaction;
      const sx = corner === 'tr' || corner === 'br' ? 1 : -1;
      const sy = corner === 'bl' || corner === 'br' ? 1 : -1;
      const vecX = sx * srcW;
      const vecY = sy * srcH;
      let s = ((x - ax) * vecX + (y - ay) * vecY) / (srcW * srcW + srcH * srcH);
      const stops = [platen.width / srcW, platen.height / srcH, 1];
      for (const st of stops) {
        if (Math.abs(s - st) / st < 0.04) { s = st; break; }
      }
      s = Math.min(Math.max(s, minScale), maxScale);
      const w = srcW * s;
      const h = srcH * s;
      setScale(s);
      setPos({ x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h });
      setPreset('custom');
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* */ }
    setInteraction({ kind: 'none' });
    setSnapH(null);
    setSnapV(null);
  };

  // --- Commit ---------------------------------------------------------------
  const proceed = () => {
    const sc = srcCanvasRef.current;
    if (!platen || !sc || rendering) return;
    setRendering(true);
    // Defer one tick so the button can paint its "Rendering…" state before the
    // Lanczos pass blocks the main thread.
    setTimeout(() => {
      const out = document.createElement('canvas');
      out.width = platen.width;
      out.height = platen.height;
      const ctx = out.getContext('2d')!;
      ctx.clearRect(0, 0, out.width, out.height);

      // Integer-aligned target size + position so the placed art has crisp
      // edges with no anti-aliased fringe.
      const tw = Math.max(1, Math.round(srcW * scale));
      const th = Math.max(1, Math.round(srcH * scale));
      const ox = Math.round(pos.x);
      const oy = Math.round(pos.y);

      if (tw === sc.width && th === sc.height) {
        // Placed at native size — no resample at all, pixel-exact.
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sc, ox, oy);
      } else {
        // Sharp Lanczos-3 up/downscale — replaces the browser's soft bicubic
        // so logo edges and lettering stay clean at platen resolution.
        const srcData = sc.getContext('2d')!.getImageData(0, 0, sc.width, sc.height);
        const scaled = lanczosResize(srcData, tw, th);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(imageDataToCanvas(scaled), ox, oy);
      }

      updateState({
        platenDimensions: platen,
        platenName: selectedTemplate,
        artPlacement: { x: ox, y: oy, w: tw, h: th, scale: tw / srcW },
        canvasData: ctx.getImageData(0, 0, out.width, out.height),
        // Drop any prealpha buffer from a previous run — this new composite
        // must be what the Background step reprocesses, not the old layout.
        prealphaCanvas: null,
        currentStep: 3,
      });
      setRendering(false);
      goToStep(3);
    }, 30);
  };

  const PRESETS: { id: Exclude<Preset, 'custom'>; label: string; sub: string }[] = [
    { id: 'fit',    label: 'Fit',    sub: 'all visible' },
    { id: 'fill',   label: 'Fill',   sub: 'cover' },
    { id: 'actual', label: 'Actual', sub: '1:1 size' },
  ];

  return (
    <div className="h-full flex flex-col gap-2.5">
      <div ref={wrapRef} className="flex-1 min-h-0 flex items-start justify-center">
        {platen && (
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{
              display: 'block',
              touchAction: 'none',
              cursor: interaction.kind === 'move' ? 'grabbing' : 'default',
            }}
          />
        )}
      </div>

      {/* Placement — primary control, big targets. */}
      <div className="grid grid-cols-3 gap-2 shrink-0">
        {PRESETS.map(p => (
          <button
            key={p.id}
            onClick={() => applyPreset(p.id)}
            className={`flex flex-col items-center justify-center py-3 rounded-xl font-semibold transition ${
              preset === p.id
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
            }`}
          >
            <span className="text-base leading-tight">{p.label}</span>
            <span className={`text-[10px] leading-tight ${preset === p.id ? 'text-blue-200' : 'text-gray-500'}`}>
              {p.sub}
            </span>
          </button>
        ))}
      </div>

      {/* Platen size — each chip shows a proportional preview of the area. */}
      <div className="grid grid-cols-2 gap-2 shrink-0">
        {TEMPLATES.map(t => {
          const sel = selectedTemplate === t.name;
          const miniW = (t.width / MAX_TEMPLATE_DIM) * 30;
          const miniH = (t.height / MAX_TEMPLATE_DIM) * 30;
          return (
            <button
              key={t.name}
              onClick={() => selectTemplate(t)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition ${
                sel ? 'border-blue-500 bg-blue-900/30' : 'border-gray-700 bg-gray-800 hover:border-gray-600'
              }`}
            >
              <span className="shrink-0 flex items-center justify-center" style={{ width: 32, height: 32 }}>
                <span
                  className={`rounded-sm border-2 ${sel ? 'border-blue-400 bg-blue-400/20' : 'border-gray-500'}`}
                  style={{ width: miniW, height: miniH }}
                />
              </span>
              <span className="min-w-0 text-left">
                <span className="block text-xs font-semibold leading-tight">{t.short}</span>
                <span className="block text-[10px] text-gray-500 leading-tight tabular-nums">{t.label}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex gap-2 shrink-0">
        <button
          onClick={() => goToStep(5)}
          className="px-4 py-3.5 bg-gray-800 hover:bg-gray-700 rounded-xl font-semibold transition text-gray-300"
        >
          Trim
        </button>
        <button
          onClick={proceed}
          disabled={!platen || rendering}
          className="flex-1 px-4 py-3.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-xl font-semibold transition"
        >
          {rendering ? 'Rendering…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
