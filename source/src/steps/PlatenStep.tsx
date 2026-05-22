import { useState, useRef, useEffect, useCallback } from 'react';
import { AppState } from '../App';

const TEMPLATES = [
  { name: 'P-Partner Regular',   short: 'P-Partner',     label: '16"×21"', width: 4800, height: 6300 },
  { name: 'P-Partner MAX',       short: 'P-Partner MAX', label: '20"×20"', width: 6000, height: 6000 },
  { name: 'Neato Regular', short: 'Neato Reg',   label: '12"×16"', width: 3600, height: 4800 },
  { name: 'Neato Jumbo',   short: 'Neato Jumbo', label: '15"×18"', width: 4500, height: 5400 },
];

type Props = {
  state: AppState;
  updateState: (updates: Partial<AppState>) => void;
  goToStep: (step: number) => void;
};

type Preset = 'whole' | 'actual' | 'fill' | 'custom';
type Corner = 'tl' | 'tr' | 'bl' | 'br';
type Interaction =
  | { kind: 'none' }
  | { kind: 'move'; px: number; py: number; ox: number; oy: number }
  | { kind: 'resize'; corner: Corner; ax: number; ay: number };

const HANDLE_R = 9;          // drawn handle radius, CSS px
const HANDLE_HIT = 26;       // touch hit radius, CSS px

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
  const containerRef = useRef<HTMLDivElement>(null);
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const src = state.croppedImage;
  const srcW = src?.width ?? 0;
  const srcH = src?.height ?? 0;

  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [platen, setPlaten] = useState<{ width: number; height: number } | null>(null);
  const [preset, setPreset] = useState<Preset>('whole');

  // The image is described purely as a scale multiplier on the native source
  // plus a top-left position on the platen. No pre-resizing of pixels — the
  // canvas draws it scaled, and export composites it once at full resolution.
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const [displayScale, setDisplayScale] = useState(1);
  const [container, setContainer] = useState({ w: 360, h: 420 });
  const [interaction, setInteraction] = useState<Interaction>({ kind: 'none' });
  const [snapH, setSnapH] = useState<'left' | 'center' | 'right' | null>(null);
  const [snapV, setSnapV] = useState<'top' | 'center' | 'bottom' | null>(null);
  const didInit = useRef(false);

  // Build the source canvas once.
  useEffect(() => {
    if (!src) return;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d')!.putImageData(src, 0, 0);
    srcCanvasRef.current = c;
  }, [src]);

  // Track the container so the platen preview always fits with no scrolling.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setContainer({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    setContainer({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!platen) return;
    const availW = Math.max(container.w - 16, 160);
    const availH = Math.max(container.h - 16, 160);
    setDisplayScale(Math.min(availW / platen.width, availH / platen.height));
  }, [platen, container]);

  // --- Placement presets ----------------------------------------------------
  // WHOLE: the whole image, as large as it can be while fully visible (scales
  //   UP as well as down), pinned to the TOP and horizontally centered.
  // ACTUAL: native 1:1 pixels, centered.
  // FILL: scaled to cover the entire platen (may crop), centered.
  const placeWhole = useCallback((dims: { width: number; height: number }) => {
    const s = Math.min(dims.width / srcW, dims.height / srcH);
    setScale(s);
    setPos({ x: (dims.width - srcW * s) / 2, y: 0 });
  }, [srcW, srcH]);

  const placeActual = useCallback((dims: { width: number; height: number }) => {
    setScale(1);
    setPos({ x: (dims.width - srcW) / 2, y: (dims.height - srcH) / 2 });
  }, [srcW, srcH]);

  const placeFill = useCallback((dims: { width: number; height: number }) => {
    const s = Math.max(dims.width / srcW, dims.height / srcH);
    setScale(s);
    setPos({ x: (dims.width - srcW * s) / 2, y: (dims.height - srcH * s) / 2 });
  }, [srcW, srcH]);

  const applyPreset = (p: Exclude<Preset, 'custom'>, dims = platen) => {
    if (!dims) return;
    setPreset(p);
    if (p === 'whole') placeWhole(dims);
    else if (p === 'actual') placeActual(dims);
    else placeFill(dims);
  };

  // On first entry: auto-pick the closest-aspect template and default to
  // WHOLE — the whole image maxed out and pinned top-center.
  useEffect(() => {
    if (didInit.current || !src) return;
    didInit.current = true;
    const ratio = srcW / srcH;
    let best = TEMPLATES[0];
    let bestDelta = Infinity;
    for (const t of TEMPLATES) {
      const d = Math.abs(t.width / t.height - ratio);
      if (d < bestDelta) { bestDelta = d; best = t; }
    }
    const dims = { width: best.width, height: best.height };
    setPlaten(dims);
    setSelectedTemplate(best.name);
    placeWhole(dims);
  }, [src, srcW, srcH, placeWhole]);

  const selectTemplate = (t: typeof TEMPLATES[0]) => {
    const dims = { width: t.width, height: t.height };
    setPlaten(dims);
    setSelectedTemplate(t.name);
    // Re-apply the active preset on the new platen (custom falls back to whole).
    if (preset === 'actual') placeActual(dims);
    else if (preset === 'fill') placeFill(dims);
    else placeWhole(dims);
  };

  // --- Geometry helpers -----------------------------------------------------
  const dispW = srcW * scale;
  const dispH = srcH * scale;

  const minScale = srcW > 0 ? Math.max(0.04, 120 / Math.max(srcW, srcH)) : 0.04;
  const maxScale = platen ? Math.max(platen.width / srcW, platen.height / srcH) * 3 : 8;

  // Handle centres in platen coordinates, clamped so they stay grabbable even
  // when the image overflows the platen (Fill mode).
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
    const cw = Math.round(platen.width * rs);
    const ch = Math.round(platen.height * rs);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      canvas.style.width = cw + 'px';
      canvas.style.height = ch + 'px';
    }

    const ctx = canvas.getContext('2d')!;
    drawCheckerboard(ctx, cw, ch);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sc, pos.x * rs, pos.y * rs, dispW * rs, dispH * rs);

    // Snap guide lines.
    ctx.strokeStyle = 'rgba(96,165,250,0.95)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    if (snapH) {
      const gx = snapH === 'left' ? 0.75 : snapH === 'right' ? cw - 0.75 : cw / 2;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, ch); ctx.stroke();
    }
    if (snapV) {
      const gy = snapV === 'top' ? 0.75 : snapV === 'bottom' ? ch - 0.75 : ch / 2;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(cw, gy); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Image outline.
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 2;
    ctx.strokeRect(pos.x * rs, pos.y * rs, dispW * rs, dispH * rs);

    // Corner resize handles, clamped inside the canvas so they're always
    // visible and tappable.
    const pts = cornerPoints();
    (Object.keys(pts) as Corner[]).forEach((c) => {
      const cx = Math.min(Math.max(pts[c].x * rs, HANDLE_R), cw - HANDLE_R);
      const cy = Math.min(Math.max(pts[c].y * rs, HANDLE_R), ch - HANDLE_R);
      ctx.beginPath();
      ctx.arc(cx, cy, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    });

    // Platen border.
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, cw - 2, ch - 2);
  }, [platen, displayScale, pos, dispW, dispH, snapH, snapV, cornerPoints]);

  // --- Pointer interaction --------------------------------------------------
  const toPlaten = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / displayScale,
      y: (e.clientY - rect.top) / displayScale,
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
      // Anchor = the opposite corner; it stays pinned during the resize.
      const pts = cornerPoints();
      const opp: Record<Corner, Corner> = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };
      const a = pts[opp[corner]];
      setInteraction({ kind: 'resize', corner, ax: a.x, ay: a.y });
      return;
    }
    // Inside the image → move.
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

      // Snap each axis independently to left/center/right and top/center/bottom.
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
      // Corner direction vector (native dimensions, signed away from anchor).
      const sx = corner === 'tr' || corner === 'br' ? 1 : -1;
      const sy = corner === 'bl' || corner === 'br' ? 1 : -1;
      const vecX = sx * srcW;
      const vecY = sy * srcH;
      // Aspect-locked scale = projection of the pointer (from anchor) onto the
      // image diagonal. Lets the dragged corner follow the finger naturally.
      let s = ((x - ax) * vecX + (y - ay) * vecY) / (srcW * srcW + srcH * srcH);

      // Snap scale to the meaningful stops: fit-width, fit-height, 1:1.
      const stops = [platen.width / srcW, platen.height / srcH, 1];
      for (const st of stops) {
        if (Math.abs(s - st) / st < 0.04) { s = st; break; }
      }
      s = Math.min(Math.max(s, minScale), maxScale);

      const w = srcW * s;
      const h = srcH * s;
      // Keep the anchor corner pinned.
      const nx = sx > 0 ? ax : ax - w;
      const ny = sy > 0 ? ay : ay - h;

      setScale(s);
      setPos({ x: nx, y: ny });
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
    if (!platen || !sc) return;
    const out = document.createElement('canvas');
    out.width = platen.width;
    out.height = platen.height;
    const ctx = out.getContext('2d')!;
    ctx.clearRect(0, 0, out.width, out.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sc, pos.x, pos.y, srcW * scale, srcH * scale);
    updateState({
      platenDimensions: platen,
      platenName: selectedTemplate.replace(/[^a-zA-Z0-9]/g, '_'),
      canvasData: ctx.getImageData(0, 0, out.width, out.height),
      currentStep: 4,
    });
    goToStep(4);
  };

  const presetBtn = (id: Exclude<Preset, 'custom'>, label: string) => (
    <button
      key={id}
      onClick={() => applyPreset(id)}
      className={`px-2 py-1.5 rounded-md text-xs font-medium transition ${
        preset === id ? 'bg-blue-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2.5">
      <div
        ref={containerRef}
        className="rounded-lg border border-gray-700 bg-gray-950 flex items-center justify-center overflow-hidden"
        style={{ height: 'calc(100dvh - 300px)', minHeight: '280px' }}
      >
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

      <div className="grid grid-cols-2 gap-1.5">
        {TEMPLATES.map(t => (
          <button
            key={t.name}
            onClick={() => selectTemplate(t)}
            className={`px-2.5 py-1.5 rounded-md text-left border transition ${
              selectedTemplate === t.name
                ? 'border-blue-500 bg-blue-900/30'
                : 'border-gray-700 bg-gray-800 hover:border-gray-600'
            }`}
          >
            <div className="text-xs font-semibold leading-tight">{t.short}</div>
            <div className="text-[10px] text-gray-500 leading-tight tabular-nums">{t.label}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {presetBtn('whole', 'Whole')}
        {presetBtn('actual', 'Actual')}
        {presetBtn('fill', 'Fill')}
      </div>

      <button
        onClick={proceed}
        disabled={!platen}
        className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg font-semibold transition text-sm"
      >
        Continue to Background Removal
      </button>
    </div>
  );
}
