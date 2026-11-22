import { useState, useEffect, useRef, useCallback } from 'react';
import { Download, Loader, AlertTriangle } from 'lucide-react';
import UPNG from 'upng-js';
import { AppState } from '../App';
import { imageDataToCanvas, get2dContext } from '../utils/imageUtils';
import { encodeDitheredPNG } from '../utils/ditherQuantize';
import { findEdgeMarks, removeMarks, type EdgeMark } from '../utils/edgeMarks';
import { edgeScanOpts } from '../utils/edgeScanOpts';

const formatBytes = (n: number) =>
  n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

type Props = {
  state: AppState;
  updateState: (updates: Partial<AppState>) => void;
  goToStep: (step: number) => void;
};

type ReviewBg = 'black' | 'white' | 'checker' | 'original' | 'mask';

export default function ExportStep({ state, updateState, goToStep }: Props) {
  // Backstop: the Background step already offered to strip edge marks, but a
  // "Keep" there, a skipped removal, or a later edit can still land marks in
  // the final file. Re-check silently and surface a banner if any survived.
  const [edgeMarks, setEdgeMarks] = useState<EdgeMark[]>([]);
  const [edgeDismissed, setEdgeDismissed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  // 'lossless' = exact pixels (default — never posterizes). 'compressed' =
  // upng-js 256-colour quantization: much smaller, but bands smooth gradients
  // (painted faces, soft shading) — only safe for flat / vector-style art.
  // 'dithered' = Floyd–Steinberg quantization: spreads the rounding error so
  // smooth gradients become fine grain instead of flat bands — photo-safe,
  // smaller than lossless, a bit larger than compressed.
  const [pngMode, setPngMode] = useState<'compressed' | 'lossless' | 'dithered'>('lossless');
  const [lastExport, setLastExport] = useState<{ size: number; saved: number } | null>(null);
  const queuedName = state.queuedImages[state.currentImageIndex]?.name?.replace(/\.[^.]+$/, '');
  const [filename, setFilename] = useState(queuedName || 'design');
  const usedNamesRef = useRef<Set<string>>(new Set());

  // Review preview defaults to Black per the project convention — most of
  // the work prints on dark shirts.
  const [reviewBg, setReviewBg] = useState<ReviewBg>('checker');
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [containerW, setContainerW] = useState(360);
  const [containerH, setContainerH] = useState(420);

  // Cached overlay so we don't rebuild the mask ImageData on every redraw
  // (it only depends on canvasData + prealphaCanvas, not on bg mode).
  const maskOverlayRef = useRef<{ canvas: HTMLCanvasElement; sig: string } | null>(null);

  useEffect(() => {
    if (queuedName) setFilename(queuedName);
  }, [queuedName]);

  useEffect(() => {
    const el = previewWrapRef.current;
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

  const hasPrealpha = !!state.prealphaCanvas;

  // Build (or reuse) the red-tint overlay for Mask mode: red wherever
  // prealpha had alpha that canvasData lost. Cached so repeated taps on
  // Mask don't re-iterate the whole image.
  const getMaskOverlay = useCallback((): HTMLCanvasElement | null => {
    const cv = state.canvasData;
    const pa = state.prealphaCanvas;
    if (!cv || !pa || cv.width !== pa.width || cv.height !== pa.height) return null;

    const sig = `${cv.width}x${cv.height}:${cv.data.byteLength}`;
    if (maskOverlayRef.current && maskOverlayRef.current.sig === sig) {
      return maskOverlayRef.current.canvas;
    }

    const w = cv.width, h = cv.height;
    const overlay = new ImageData(w, h);
    const ov = overlay.data;
    const a = pa.data;
    const b = cv.data;
    for (let i = 0; i < ov.length; i += 4) {
      const loss = a[i + 3] - b[i + 3];
      if (loss > 0) {
        ov[i] = 255;
        ov[i + 1] = 40;
        ov[i + 2] = 40;
        ov[i + 3] = loss > 180 ? 180 : loss;
      }
    }
    const canvas = imageDataToCanvas(overlay);
    maskOverlayRef.current = { canvas, sig };
    return canvas;
  }, [state.canvasData, state.prealphaCanvas]);

  const redrawPreview = useCallback(() => {
    const canvas = previewCanvasRef.current;
    const cv = state.canvasData;
    if (!canvas || !cv) return;

    // Choose image source by mode. Original/Mask need prealpha; if missing
    // (skip-alpha session, legacy state), fall back to canvasData.
    const isOriginalMode = reviewBg === 'original' && hasPrealpha;
    const sourceImg = isOriginalMode && state.prealphaCanvas ? state.prealphaCanvas : cv;

    const imgW = sourceImg.width;
    const imgH = sourceImg.height;
    const scale = Math.min((containerW - 4) / imgW, (containerH - 4) / imgH, 1);
    const cssW = Math.max(1, Math.round(imgW * scale));
    const cssH = Math.max(1, Math.round(imgH * scale));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);

    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    if (canvas.style.width !== cssW + 'px' || canvas.style.height !== cssH + 'px') {
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
    }

    const ctx = get2dContext(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Background fill.
    if (reviewBg === 'checker' || reviewBg === 'original' || reviewBg === 'mask') {
      const sz = 10;
      for (let y = 0; y < cssH; y += sz) {
        for (let x = 0; x < cssW; x += sz) {
          ctx.fillStyle = ((Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0) ? '#374151' : '#4b5563';
          ctx.fillRect(x, y, sz, sz);
        }
      }
    } else {
      ctx.fillStyle = reviewBg === 'white' ? '#ffffff' : '#000000';
      ctx.fillRect(0, 0, cssW, cssH);
    }

    // Image (final by default; original if that mode is active and prealpha exists).
    const imgCanvas = imageDataToCanvas(sourceImg);
    ctx.drawImage(imgCanvas, 0, 0, cssW, cssH);

    // Mask mode: composite red tint over the original showing what got
    // removed during the alpha step.
    if (reviewBg === 'mask') {
      const overlay = getMaskOverlay();
      if (overlay) {
        ctx.drawImage(overlay, 0, 0, cssW, cssH);
      }
    }
  }, [state.canvasData, state.prealphaCanvas, reviewBg, hasPrealpha, containerW, containerH, getMaskOverlay]);

  useEffect(() => {
    redrawPreview();
  }, [redrawPreview]);

  // Disabled modes that need prealpha — keep the buttons visible but greyed
  // so a user mid-session sees the option exists.
  const modes: { id: ReviewBg; label: string; needsPrealpha?: boolean }[] = [
    { id: 'black',    label: 'Black' },
    { id: 'white',    label: 'White' },
    { id: 'checker',  label: 'Checker' },
    { id: 'original', label: 'Original', needsPrealpha: true },
    { id: 'mask',     label: 'Mask',     needsPrealpha: true },
  ];

  // Plain download fallback for platforms without the Web Share sheet.
  const anchorDownload = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportImage = async () => {
    if (!state.canvasData) return;

    setExporting(true);
    setExportProgress(30);

    try {
      // Always produce the lossless PNG via the browser encoder first.
      const canvas = imageDataToCanvas(state.canvasData);
      const losslessBlob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, 'image/png'),
      );
      if (!losslessBlob) {
        alert('Failed to create image');
        setExporting(false);
        return;
      }
      setExportProgress(45);

      let blob: Blob = losslessBlob;
      if (pngMode === 'compressed') {
        // Let the progress bar paint before the (synchronous) quantize.
        await new Promise((r) => setTimeout(r, 30));
        try {
          // upng-js k-means colour quantization (TinyPNG-style). It wins big
          // on upscaled art with thousands of near-duplicate colours, but can
          // *bloat* gradient-heavy images — so keep it only if it's smaller.
          const cd = state.canvasData;
          const rgba = cd.data.buffer.slice(
            cd.data.byteOffset,
            cd.data.byteOffset + cd.data.byteLength,
          );
          const png = UPNG.encode([rgba], cd.width, cd.height, 256);
          const quant = new Blob([png], { type: 'image/png' });
          if (quant.size < losslessBlob.size) blob = quant;
        } catch (e) {
          console.error('Quantize failed — keeping lossless PNG:', e);
        }
      } else if (pngMode === 'dithered') {
        await new Promise((r) => setTimeout(r, 30));
        try {
          // Floyd–Steinberg error diffusion onto a 255-colour palette. Trades
          // the flat posterized bands of plain quantization for fine grain,
          // so painted faces / soft shading survive. Bigger than 'compressed'
          // (grain compresses worse) but still well under lossless — keep it
          // only if it actually came out smaller.
          const cd = state.canvasData;
          const { buffer } = await encodeDitheredPNG(
            cd.data,
            cd.width,
            cd.height,
            (frac) => setExportProgress(45 + Math.round(frac * 22)),
          );
          const dithered = new Blob([buffer], { type: 'image/png' });
          if (dithered.size < losslessBlob.size) blob = dithered;
        } catch (e) {
          console.error('Dither failed — keeping lossless PNG:', e);
        }
      }
      setExportProgress(70);

      const cleanFilename = filename.replace(/\.[^.]+$/, '').slice(0, 80) || 'design';
      const platenPrefix = state.platenName ? `${state.platenName.replace(/[^a-zA-Z0-9]/g, "_")}_` : "";
      const baseName = `${platenPrefix}${cleanFilename}`;

      let finalName = `${baseName}.png`;
      if (usedNamesRef.current.has(finalName)) {
        let n = 2;
        while (usedNamesRef.current.has(`${baseName}_${n}.png`)) n++;
        finalName = `${baseName}_${n}.png`;
      }
      usedNamesRef.current.add(finalName);
      setLastExport({
        size: blob.size,
        saved: 1 - blob.size / losslessBlob.size,
      });

      const file = new File([blob], finalName, { type: 'image/png' });
      const nav = navigator as Navigator & {
        canShare?: (d: { files: File[] }) => boolean;
        share?: (d: { files: File[] }) => Promise<void>;
      };

      // Route to the iOS share sheet whenever it exists — "Save Image" there
      // drops the file straight into Photos. canShare() is only a hint and
      // returns false for large files on iOS; calling share() anyway still
      // works and avoids the anchor-download fallback, which on iOS opens a
      // preview tab instead of saving. Fall back to the anchor only when
      // share is genuinely unavailable or actually fails.
      let saved = false;
      if (typeof nav.share === 'function') {
        try {
          await nav.share({ files: [file] });
          saved = true;
        } catch (err) {
          // Cancelling the sheet throws AbortError — the user chose not to
          // save, so treat it as handled rather than dumping a preview tab.
          if (err instanceof Error && err.name === 'AbortError') saved = true;
        }
      }
      if (!saved) anchorDownload(blob, finalName);

      setExportProgress(100);
      setTimeout(() => setExporting(false), 600);
    } catch (error) {
      alert('Export error: ' + error);
      setExporting(false);
    }
  };

  const hasMore = state.queuedImages.length > state.currentImageIndex + 1;

  const processNext = () => {
    if (!hasMore) return;
    // Clear the cached overlay so the next image doesn't show the previous
    // image's mask before the redraw fires.
    maskOverlayRef.current = null;
    updateState({
      currentImageIndex: state.currentImageIndex + 1,
      currentStep: 1,
      sourceImage: null,
      croppedImage: null,
      canvasData: null,
      prealphaCanvas: null,
    });
    goToStep(1);
  };

  const reset = () => {
    maskOverlayRef.current = null;
    updateState({
      currentStep: 1,
      sourceImage: null,
      croppedImage: null,
      platenDimensions: null,
      canvasData: null,
      prealphaCanvas: null,
      currentImageIndex: 0,
      queuedImages: [],
    });
    goToStep(1);
  };

  useEffect(() => {
    if (!state.canvasData) { setEdgeMarks([]); return; }
    try {
      setEdgeMarks(findEdgeMarks(state.canvasData, edgeScanOpts(state)).marks);
    } catch {
      setEdgeMarks([]);
    }
  }, [state.canvasData]);

  const stripEdgeMarks = () => {
    if (!state.canvasData || edgeMarks.length === 0) return;
    updateState({ canvasData: removeMarks(state.canvasData, edgeMarks) });
    setEdgeMarks([]);
  };

  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <h2 className="text-3xl font-bold mb-1">Export</h2>
        <p className="text-gray-400 text-sm">Check the result on different backgrounds before saving.</p>
      </div>

      {edgeMarks.length > 0 && !edgeDismissed && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-950 border border-amber-900/70 rounded-lg">
          <AlertTriangle size={17} className="text-amber-300 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-amber-200 text-sm font-semibold">
              {edgeMarks.length} edge {edgeMarks.length === 1 ? 'mark' : 'marks'} still in this file
            </p>
            <p className="text-amber-400/80 text-xs mt-0.5">
              {edgeMarks.map(m => m.side).filter((v, i, a) => a.indexOf(v) === i).join(', ')} — thin lines isolated from the artwork
            </p>
          </div>
          <button onClick={stripEdgeMarks}
            className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-amber-950 rounded text-xs font-semibold transition shrink-0">
            Remove
          </button>
          <button onClick={() => setEdgeDismissed(true)}
            className="px-2 py-1.5 text-amber-400/70 hover:text-amber-200 text-xs transition shrink-0">
            Keep
          </button>
        </div>
      )}

      {state.canvasData && (
        <>
          {/* Review preview */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 bg-gray-800 rounded-lg px-2 py-1.5 flex-wrap">
              {modes.map(m => {
                const disabled = !!m.needsPrealpha && !hasPrealpha;
                const active = reviewBg === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => !disabled && setReviewBg(m.id)}
                    disabled={disabled}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${
                      active ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                    }`}
                  >
                    {m.id === 'black'    && <span className="w-3 h-3 rounded-sm bg-black border border-gray-500" />}
                    {m.id === 'white'    && <span className="w-3 h-3 rounded-sm bg-white border border-gray-500" />}
                    {m.id === 'checker'  && <span className="w-3 h-3 rounded-sm" style={{ background: 'repeating-conic-gradient(#888 0% 25%,#555 0% 50%) 0 0/6px 6px' }} />}
                    {m.id === 'original' && <span className="w-3 h-3 rounded-sm bg-amber-900/60 border border-amber-500" />}
                    {m.id === 'mask'     && <span className="w-3 h-3 rounded-sm bg-red-900/60 border border-red-500" />}
                    {m.label}
                  </button>
                );
              })}
            </div>

            <div
              ref={previewWrapRef}
              className="rounded-lg border border-gray-700 bg-gray-950 flex items-center justify-center overflow-hidden"
              style={{ height: '55vh', minHeight: 320 }}
            >
              <canvas ref={previewCanvasRef} style={{ display: 'block' }} />
            </div>
          </div>

          {/* File info + filename */}
          <div className="bg-gray-800 p-4 rounded-lg space-y-3">
            <div>
              <label className="text-sm font-semibold block mb-1">Filename</label>
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="design"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
              />
              <p className="text-xs text-gray-400 mt-1">
                Final: {state.platenName ? state.platenName.replace(/[^a-zA-Z0-9]/g, '_') + '_' : ''}{filename || 'design'}.png
              </p>
            </div>

            <div>
              <label className="text-sm font-semibold block mb-1.5">PNG compression</label>
              <div className="grid grid-cols-1 gap-2">
                <button
                  onClick={() => setPngMode('lossless')}
                  className={`px-3 py-2.5 rounded-lg text-sm font-semibold text-left transition ${
                    pngMode === 'lossless'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Lossless
                  <span className="block text-[11px] font-normal opacity-75">Exact pixels — safe for everything, largest file</span>
                </button>
                <button
                  onClick={() => setPngMode('dithered')}
                  className={`px-3 py-2.5 rounded-lg text-sm font-semibold text-left transition ${
                    pngMode === 'dithered'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Dithered
                  <span className="block text-[11px] font-normal opacity-75">Smaller, no banding — adds fine grain; safe for faces &amp; gradients</span>
                </button>
                <button
                  onClick={() => setPngMode('compressed')}
                  className={`px-3 py-2.5 rounded-lg text-sm font-semibold text-left transition ${
                    pngMode === 'compressed'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Compressed
                  <span className="block text-[11px] font-normal opacity-75">Smallest — flat / vector art only, bands smooth faces</span>
                </button>
              </div>
            </div>

            <div className="bg-gray-900 p-3 rounded border border-gray-700 text-xs text-gray-300 space-y-0.5 tabular-nums">
              <p>
                {state.canvasData.width} × {state.canvasData.height} px · 300 DPI · PNG
                {pngMode === 'lossless'
                  ? ' (lossless RGBA)'
                  : pngMode === 'dithered'
                    ? ' (dithered, fine grain)'
                    : ' (compressed)'}
              </p>
              {lastExport && (
                <p className="text-green-400">
                  Last export · {formatBytes(lastExport.size)}
                  {lastExport.saved > 0.03
                    ? ` · ${Math.round(lastExport.saved * 100)}% smaller`
                    : ' · already optimal'}
                </p>
              )}
            </div>

            {exporting && (
              <div className="bg-blue-900/30 border border-blue-500 p-3 rounded">
                <div className="flex items-center gap-2 mb-1.5">
                  <Loader size={16} className="animate-spin" />
                  <p className="text-blue-200 text-sm">Processing export…</p>
                </div>
                <div className="w-full bg-gray-700 rounded-full h-1.5">
                  <div className="bg-blue-500 h-1.5 rounded-full transition-all" style={{ width: `${exportProgress}%` }} />
                </div>
              </div>
            )}

            <button
              onClick={exportImage}
              disabled={exporting}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg font-semibold transition"
            >
              <Download size={18} />
              Export PNG
            </button>
          </div>
        </>
      )}

      <div className="space-y-3 border-t border-gray-700 pt-5">
        {hasMore ? (
          <button
            onClick={processNext}
            disabled={exporting}
            className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg font-semibold transition"
          >
            Next Image ({state.currentImageIndex + 2} of {state.queuedImages.length})
          </button>
        ) : (
          <button
            onClick={reset}
            className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold transition"
          >
            {state.queuedImages.length > 0 ? 'Done — Start Over' : 'Process Another Image'}
          </button>
        )}
      </div>
    </div>
  );
}
