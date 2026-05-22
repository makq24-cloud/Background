import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ZoomIn, ZoomOut, Pipette, Maximize2 } from 'lucide-react';
import { AppState } from '../App';
import { applyTrueColorToAlpha, downscalePreview, detectDominantShade } from '../utils/alphaEngine';
import { runAlpha } from '../utils/alphaClient';
import { imageDataToCanvas, cloneImageData } from '../utils/imageUtils';

type Props = {
  state: AppState;
  updateState: (updates: Partial<AppState>) => void;
  goToStep: (step: number) => void;
};

type BgMode = 'checker' | 'white' | 'black' | 'custom' | 'original' | 'mask';

const MAX_PREVIEW = 1600;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

export default function AlphaStep({ state, updateState, goToStep }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  const [sensitivity, setSensitivity] = useState(state.alphaSettings.alphaBase || 10);
  const [softness, setSoftness] = useState(state.alphaSettings.alphaContrast || 15);
  const [targetColor, setTargetColor] = useState(rgbToHex(...state.alphaSettings.targetColor));
  const [bgMode, setBgMode] = useState<BgMode>('checker');
  const [customBgColor, setCustomBgColor] = useState('#888888');
  const [zoom, setZoom] = useState(1);
  const [processedPreview, setProcessedPreview] = useState<ImageData | null>(null);
  const [originalPreview, setOriginalPreview] = useState<ImageData | null>(null);
  const [eyedropperActive, setEyedropperActive] = useState(false);
  const [hoveredColor, setHoveredColor] = useState<string | null>(null);
  const [shirtDetecting, setShirtDetecting] = useState<'dark' | 'light' | null>(null);
  const [committing, setCommitting] = useState(false);
  const [autoDetected, setAutoDetected] = useState(false);

  const sourceImg = state.canvasData;
  const isOriginalView = bgMode === 'original';
  const isMaskView = bgMode === 'mask';
  // In mask mode the original image stays visible underneath the red tint
  // overlay; the processed result is only used to derive the tint.
  const activePreview = (isOriginalView || isMaskView) ? originalPreview : processedPreview;

  // Pre-downscale once per image. Live scrubbing then runs on the small image.
  const previewSource = useMemo(
    () => (sourceImg ? downscalePreview(sourceImg, MAX_PREVIEW) : null),
    [sourceImg]
  );

  useEffect(() => {
    if (previewSource) setOriginalPreview(previewSource);
  }, [previewSource]);

  useEffect(() => {
    if (!previewSource) return;
    const [r, g, b] = hexToRgb(targetColor);
    const processed = applyTrueColorToAlpha(previewSource, r, g, b, sensitivity, softness);
    setProcessedPreview(processed);
  }, [previewSource, sensitivity, softness, targetColor]);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activePreview) return;

    const pw = activePreview.width;
    const ph = activePreview.height;

    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (bgMode === 'checker' || bgMode === 'original' || bgMode === 'mask') {
      const sz = Math.max(4, Math.round(10 / zoom));
      for (let y = 0; y < ph; y += sz) {
        for (let x = 0; x < pw; x += sz) {
          ctx.fillStyle = ((Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0) ? '#374151' : '#4b5563';
          ctx.fillRect(x, y, sz, sz);
        }
      }
    } else if (bgMode === 'white') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pw, ph);
    } else if (bgMode === 'black') {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, pw, ph);
    } else {
      ctx.fillStyle = customBgColor;
      ctx.fillRect(0, 0, pw, ph);
    }

    const tmp = imageDataToCanvas(activePreview);
    ctx.drawImage(tmp, 0, 0);

    // Mask preview: overlay a red tint proportional to alpha loss so the user
    // can see WHICH pixels the current settings are about to remove before
    // they commit. Built per-redraw from original vs processed previews.
    if (bgMode === 'mask' && originalPreview && processedPreview &&
        originalPreview.width === pw && processedPreview.width === pw) {
      const overlay = new ImageData(pw, ph);
      const od = originalPreview.data;
      const pd = processedPreview.data;
      const ov = overlay.data;
      for (let i = 0; i < ov.length; i += 4) {
        const loss = od[i + 3] - pd[i + 3];
        if (loss > 0) {
          ov[i] = 255;
          ov[i + 1] = 40;
          ov[i + 2] = 40;
          // Cap the tint at ~70% opacity so the underlying image still reads.
          ov[i + 3] = Math.min(180, loss);
        }
      }
      const overlayCanvas = imageDataToCanvas(overlay);
      ctx.drawImage(overlayCanvas, 0, 0);
    }
  }, [activePreview, bgMode, customBgColor, zoom, originalPreview, processedPreview]);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(drawCanvas);
  }, [drawCanvas]);

  const getSourcePixel = useCallback((e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>): [number, number, number] | null => {
    if (!sourceImg || !canvasRef.current || !activePreview) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width * activePreview.width;
    const cy = (e.clientY - rect.top) / rect.height * activePreview.height;
    const sx = clamp(Math.floor(cx * (sourceImg.width / activePreview.width)), 0, sourceImg.width - 1);
    const sy = clamp(Math.floor(cy * (sourceImg.height / activePreview.height)), 0, sourceImg.height - 1);
    const idx = (sy * sourceImg.width + sx) * 4;
    return [sourceImg.data[idx], sourceImg.data[idx + 1], sourceImg.data[idx + 2]];
  }, [sourceImg, activePreview]);



  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!eyedropperActive) return;
    const c = getSourcePixel(e);
    if (c) setHoveredColor(rgbToHex(...c));
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = getSourcePixel(e);
    if (c) {
      setTargetColor(rgbToHex(...c));
      setEyedropperActive(false);
      setHoveredColor(null);
      updateState({ alphaUserTuned: true });
    }
  };

  const autoDetectShirt = useCallback((mode: 'dark' | 'light') => {
    if (!sourceImg) return;
    setShirtDetecting(mode);
    setTimeout(() => {
      const detected = detectDominantShade(sourceImg, mode);
      if (detected) {
        setTargetColor(rgbToHex(...detected));
        setSensitivity(10);
        setSoftness(15);
      } else {
        setTargetColor(mode === 'dark' ? '#000000' : '#ffffff');
      }
      setShirtDetecting(null);
    }, 0);
  }, [sourceImg]);

  // Auto-detect the dominant background shade on first entry so the user
  // sees a meaningful preview immediately. Skipped on later batch images
  // if the user has already tuned settings — keeps their choices across
  // a batch instead of resetting per image. They can still tap Auto Black /
  // Auto White manually to re-detect.
  useEffect(() => {
    if (autoDetected || !sourceImg) return;
    setAutoDetected(true);
    if (!state.alphaUserTuned) {
      autoDetectShirt('dark');
    }
  }, [sourceImg, autoDetected, autoDetectShirt, state.alphaUserTuned]);

  const skipAlphaRemoval = () => {
    if (!sourceImg) return;
    // Skip path: no removal happens. canvasData needs its own buffer because
    // the restore brush will mutate it; prealpha can share sourceImg's bytes
    // since neither side modifies them. One clone instead of two.
    updateState({
      canvasData: cloneImageData(sourceImg),
      prealphaCanvas: sourceImg,
      currentStep: 5,
    });
    goToStep(5);
  };

  const proceed = async () => {
    if (!sourceImg || committing) return;
    setCommitting(true);
    const [r, g, b] = hexToRgb(targetColor);

    try {
      // Source buffer transfers to the worker — sourceImg becomes unreadable
      // here for the duration. The worker hands BOTH buffers back, so we
      // rebuild fresh ImageDatas for canvasData (result) and prealphaCanvas
      // (source, untouched bytes) without a separate clone allocation.
      const { prealpha, result } = await runAlpha(sourceImg, r, g, b, sensitivity, softness);
      updateState({
        canvasData: result,
        prealphaCanvas: prealpha,
        alphaSettings: { targetColor: [r, g, b], alphaBase: sensitivity, alphaContrast: softness },
        alphaUserTuned: true,
        currentStep: 5,
      });
      goToStep(5);
    } catch (err) {
      console.error('Alpha worker failed:', err);

      // After postMessage's transfer succeeds the buffer is DETACHED on
      // the main thread — typed array length goes to 0. Trying to fall
      // back synchronously in that state would silently produce garbage
      // (clones of an empty buffer, then algorithm on all zeros). Detect
      // and surface that case instead.
      if (sourceImg.data.byteLength === 0) {
        // Drop the broken canvasData and send the user back to Import.
        // ImportStep's auto-load picks up the queued file at the current
        // index, so they only lose crop + platen positioning — not the file.
        updateState({
          sourceImage: null,
          croppedImage: null,
          canvasData: null,
          prealphaCanvas: null,
          currentStep: 1,
        });
        goToStep(1);
        setCommitting(false);
        alert('The background processor crashed mid-commit. The image will reload from your queue — please re-crop and try again.');
        return;
      }

      // Worker failed BEFORE transfer (e.g. construction error). Buffer
      // still valid — safe to run on main thread. Use sourceImg directly
      // as prealpha since applyTrueColorToAlpha does not mutate input.
      try {
        const final = applyTrueColorToAlpha(sourceImg, r, g, b, sensitivity, softness);
        updateState({
          canvasData: final,
          prealphaCanvas: sourceImg,
          alphaSettings: { targetColor: [r, g, b], alphaBase: sensitivity, alphaContrast: softness },
          alphaUserTuned: true,
          currentStep: 5,
        });
        goToStep(5);
      } catch (e) {
        console.error('Main-thread fallback also failed:', e);
        alert('Processing failed. Please try again — if it keeps happening, reload the page.');
      }
    } finally {
      setCommitting(false);
    }
  };

  // Auto-fit zoom so the canvas fills the available width on first render
  // and whenever the source changes. Users can still zoom in/out from here.
  const fitToScreen = useCallback(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap || !previewSource) return;
    const avail = wrap.clientWidth - 4; // small padding
    if (avail <= 0) return;
    setZoom(clamp(avail / previewSource.width, 0.1, 4));
  }, [previewSource]);

  useEffect(() => {
    fitToScreen();
    // Re-fit whenever the wrap's measured width changes — covers orientation
    // change, the initial layout settling after mount, and the moment when
    // the preview image arrives and the wrap finally has a non-zero width.
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => fitToScreen());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fitToScreen]);

  const bgButtons: { id: BgMode; label: string }[] = [
    { id: 'checker',  label: 'Transparent' },
    { id: 'white',    label: 'White' },
    { id: 'black',    label: 'Black' },
    { id: 'custom',   label: 'Custom' },
    { id: 'original', label: 'Original' },
    { id: 'mask',     label: 'Mask' },
  ];

  const previewW = activePreview?.width ?? 0;
  const previewH = activePreview?.height ?? 0;
  const scaledW = Math.round(previewW * zoom);
  const scaledH = Math.round(previewH * zoom);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-start">

        <div className="flex-1 flex flex-col gap-2 min-w-0">
          <div className="flex items-center gap-1.5 bg-gray-800 rounded-lg px-2 py-1.5 flex-wrap shrink-0">
            <span className="text-xs text-gray-400 font-medium mr-1 hidden sm:inline">Preview:</span>
            {bgButtons.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setBgMode(id)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition ${
                  bgMode === id
                    ? id === 'original' ? 'bg-amber-600 text-white' : 'bg-blue-600 text-white'
                    : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                }`}
              >
                {id === 'checker' && <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: 'repeating-conic-gradient(#888 0% 25%,#555 0% 50%) 0 0/6px 6px' }} />}
                {id === 'white'   && <span className="w-3 h-3 rounded-sm border border-gray-500 bg-white shrink-0" />}
                {id === 'black'   && <span className="w-3 h-3 rounded-sm bg-black border border-gray-500 shrink-0" />}
                {id === 'custom'  && <span className="w-3 h-3 rounded-sm border border-gray-500 shrink-0" style={{ background: customBgColor }} />}
                {id === 'original' && <span className="w-3 h-3 rounded-sm border border-amber-500 bg-amber-900/40 shrink-0" />}
                {label}
              </button>
            ))}
            {bgMode === 'custom' && (
              <input type="color" value={customBgColor} onChange={e => setCustomBgColor(e.target.value)}
                className="w-7 h-6 rounded cursor-pointer bg-transparent border-0" />
            )}

            <div className="w-px h-5 bg-gray-600 mx-1" />

            <button onClick={() => setZoom(z => Math.max(z / 1.4, 0.1))}
              className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" title="Zoom out"><ZoomOut size={14} /></button>
            <span className="text-xs text-gray-400 w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(z * 1.4, 12))}
              className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" title="Zoom in"><ZoomIn size={14} /></button>
            <button onClick={fitToScreen}
              className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" title="Fit to screen"><Maximize2 size={12} /></button>
          </div>

          {isOriginalView && (
            <div className="bg-amber-900/20 border border-amber-700/40 rounded px-3 py-1.5 text-xs text-amber-300 shrink-0">
              Showing original image before any removal
            </div>
          )}

          <div ref={canvasWrapRef} className="overflow-auto rounded-lg border border-gray-700 bg-gray-950">
            <div style={{
              width: scaledW > 0 ? scaledW : undefined,
              height: scaledH > 0 ? scaledH : undefined,
              minHeight: 200,
              position: 'relative',
            }}>
              <canvas
                ref={canvasRef}
                onClick={handleCanvasClick}
                onPointerMove={handleCanvasPointerMove}
                onPointerLeave={() => eyedropperActive && setHoveredColor(null)}
                style={{
                  display: 'block',
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  transformOrigin: 'top left',
                  transform: `scale(${zoom})`,
                  imageRendering: zoom > 2 ? 'pixelated' : 'auto',
                  cursor: eyedropperActive ? 'crosshair' : 'default',
                  touchAction: eyedropperActive ? 'none' : 'auto',
                }}
              />
            </div>
          </div>

          {eyedropperActive && (
            <div className="flex items-center gap-2 bg-gray-800 px-3 py-2 rounded-lg text-sm shrink-0">
              {hoveredColor ? (
                <>
                  <span className="w-5 h-5 rounded border border-gray-500 shrink-0" style={{ background: hoveredColor }} />
                  <span className="font-mono text-gray-300">{hoveredColor}</span>
                  <span className="text-gray-500 text-xs">— click to select</span>
                </>
              ) : (
                <span className="text-gray-400 text-xs">Hover over the image to preview color, then click to select</span>
              )}
            </div>
          )}
        </div>

        <div className="w-full lg:w-60 lg:shrink-0 lg:sticky lg:top-0 lg:self-start space-y-3">
          <div className="bg-gray-800 p-3 rounded-lg space-y-3">

            <div>
              <label className="text-sm font-semibold block mb-1.5">Target Color (background to remove)</label>
              <div className="flex gap-2 items-center">
                <div className="w-9 h-9 rounded border-2 border-gray-600 shrink-0" style={{ background: targetColor }} />
                <input
                  type="text"
                  value={targetColor}
                  onChange={e => { if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) { setTargetColor(e.target.value); updateState({ alphaUserTuned: true }); } }}
                  className="flex-1 min-w-0 px-2 py-1.5 bg-gray-700 border border-gray-600 rounded font-mono text-xs"
                  maxLength={7}
                />
                <input
                  type="color"
                  value={targetColor.length === 7 ? targetColor : '#ffffff'}
                  onChange={e => { setTargetColor(e.target.value); updateState({ alphaUserTuned: true }); }}
                  className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 shrink-0"
                />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-2">
                <button
                  onClick={() => { setEyedropperActive(a => !a); setHoveredColor(null); }}
                  className={`flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs font-medium transition ${
                    eyedropperActive ? 'bg-amber-600 hover:bg-amber-700 text-white' : 'bg-gray-700 hover:bg-gray-600'
                  }`}
                >
                  <Pipette size={12} />
                  {eyedropperActive ? 'Tap…' : 'Pick'}
                </button>
                <button
                  onClick={() => autoDetectShirt('dark')}
                  disabled={!!shirtDetecting}
                  className="flex items-center justify-center gap-1 px-2 py-1.5 bg-gray-900 hover:bg-black border border-gray-600 rounded text-xs font-medium transition disabled:opacity-60"
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-gray-900 border border-gray-500 shrink-0" />
                  {shirtDetecting === 'dark' ? '…' : 'Auto Black'}
                </button>
                <button
                  onClick={() => autoDetectShirt('light')}
                  disabled={!!shirtDetecting}
                  className="flex items-center justify-center gap-1 px-2 py-1.5 bg-gray-100 hover:bg-white text-gray-900 border border-gray-300 rounded text-xs font-medium transition disabled:opacity-60"
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-white border border-gray-400 shrink-0" />
                  {shirtDetecting === 'light' ? '…' : 'Auto White'}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1.5 leading-snug">
                Tap the image to pick a color, or auto-detect the dominant dark/light shade.
              </p>
            </div>

            <div className="border-t border-gray-700 pt-2.5">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-semibold">Threshold</label>
                  <span className="font-mono text-blue-400 text-sm">{sensitivity}</span>
                </div>
                <input type="range" min="0" max="100" value={sensitivity}
                  onChange={e => { setSensitivity(parseInt(e.target.value)); updateState({ alphaUserTuned: true }); }}
                  className="w-full accent-blue-500" />
                <p className="text-xs text-gray-500 mt-0.5 leading-snug">How close to target color counts as background.</p>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-semibold">Edge Softness</label>
                <span className="font-mono text-blue-400 text-sm">{softness}</span>
              </div>
              <input type="range" min="0" max="100" value={softness}
                onChange={e => { setSoftness(parseInt(e.target.value)); updateState({ alphaUserTuned: true }); }}
                className="w-full accent-blue-500" />
              <p className="text-xs text-gray-500 mt-0.5 leading-snug">Feathered fade at the boundary.</p>
            </div>

            <div className="pt-2 border-t border-gray-700 space-y-1.5">
              <p className="text-xs text-gray-500">Quick Presets</p>
              <div className="grid grid-cols-2 gap-1.5">
                <button onClick={() => { setTargetColor('#ffffff'); setSensitivity(10); setSoftness(15); updateState({ alphaUserTuned: true }); }}
                  className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition">White BG</button>
                <button onClick={() => { setTargetColor('#000000'); setSensitivity(10); setSoftness(15); updateState({ alphaUserTuned: true }); }}
                  className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition">Black BG</button>
                <button onClick={() => { setSensitivity(25); setSoftness(20); updateState({ alphaUserTuned: true }); }}
                  className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition">Aggressive</button>
                <button onClick={() => { setSensitivity(5); setSoftness(30); updateState({ alphaUserTuned: true }); }}
                  className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition">Gentle</button>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <button onClick={proceed} disabled={committing}
              className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg font-semibold transition text-sm">
              {committing ? 'Processing full resolution…' : 'Continue to Touch-Up'}
            </button>
            <button onClick={skipAlphaRemoval} disabled={committing}
              className="w-full px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:bg-gray-600 rounded-lg text-xs text-gray-400 transition">
              Skip — image already has alpha
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}