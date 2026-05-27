import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ZoomIn, ZoomOut, Pipette, Maximize2 } from 'lucide-react';
import { AppState } from '../App';
import {
  applyTrueColorToAlpha, applyColorToAlpha, applyHalftone,
  downscalePreview, detectDominantShade, detectBackgroundShade,
} from '../utils/alphaEngine';
import { runAlpha } from '../utils/alphaClient';
import { imageDataToCanvas, cloneImageData } from '../utils/imageUtils';
import {
  analyzeSpecks, removeSpecksInPlace, computeIsolation,
  SURVEY_MIN, FRAGMENT_MAX, CONTENT_BIG,
} from '../utils/dotCleanup';

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

// A fragment counts as a "loose floater" worth surveying once it sits at least
// this far (preview px) from the artwork — close-to-art detail is left alone.
const SURVEY_ISO = 14;

export default function AlphaStep({ state, updateState, goToStep }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  const [sensitivity, setSensitivity] = useState(state.alphaSettings.alphaBase || 10);
  const [softness, setSoftness] = useState(state.alphaSettings.alphaContrast || 15);
  // 'solid' = bounded edge feather (opaque interiors). 'c2a' = true Photopea
  // color-to-alpha: graduated transparency everywhere + decontamination.
  // 'halftone' = clustered-dot screening: the fade becomes solid dots, with
  // zero semi-transparent pixels in the output.
  const [colorMode, setColorMode] = useState<'solid' | 'c2a' | 'halftone'>('solid');
  // Color-to-alpha: how much artwork to hold fully solid (higher = less
  // wash-out). Passed to the engine inverted as the opacity threshold.
  const [keepSolid, setKeepSolid] = useState(60);
  // Halftone settings. lpi = dot frequency (15-60, lower = bigger dots);
  // screenAngle = screen rotation; halftoneFade = width of the dotted
  // transition band between knocked-out background and solid artwork.
  const [lpi, setLpi] = useState(30);
  const [screenAngle, setScreenAngle] = useState(45);
  const [halftoneFade, setHalftoneFade] = useState(50);
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
  const [dotCleanup, setDotCleanup] = useState(0);

  // Dot cleanup: the slider sets the largest speck (in preview pixels) that
  // gets erased. Quadratic so the low end stays fine-grained.
  // Dot Cleanup slider now controls how far IN from the artwork the cleanup
  // reaches: higher = more aggressive = sweeps floaters closer to the design.
  // 0 disables it (isolationMin = Infinity -> nothing erased).
  const isolationMin = dotCleanup > 0 ? clamp(150 - dotCleanup * 1.44, 6, 200) : Infinity;

  // Always process from the untouched platen composite. prealphaCanvas holds
  // it after a prior run; on first entry it's null so we fall back to
  // canvasData (which IS the fresh composite at that point). Without this,
  // re-entering from Export would re-remove the background from an already
  // transparent image and erode the artwork.
  const sourceImg = state.prealphaCanvas ?? state.canvasData;
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
    let processed: ImageData;
    if (colorMode === 'c2a') {
      processed = applyColorToAlpha(previewSource, r, g, b, sensitivity, 100 - keepSolid);
    } else if (colorMode === 'halftone') {
      // The halftone cell pitch is defined in full-resolution pixels
      // (300 DPI ÷ LPI). The preview runs on a downscaled image, so the
      // cell is scaled by the same ratio to keep the dots visually
      // representative of what the committed full-res file will show.
      const fullCell = 300 / Math.max(1, lpi);
      const scale = sourceImg ? previewSource.width / sourceImg.width : 1;
      processed = applyHalftone(
        previewSource, r, g, b, sensitivity, halftoneFade, fullCell * scale, screenAngle,
      );
    } else {
      processed = applyTrueColorToAlpha(previewSource, r, g, b, sensitivity, softness);
    }
    setProcessedPreview(processed);
  }, [previewSource, sourceImg, sensitivity, softness, targetColor, colorMode, keepSolid, lpi, screenAngle, halftoneFade]);

  // Connected-component analysis. Runs whenever the preview is ready — NOT
  // gated on the slider — so the screen can passively tell the user whether
  // the transparent areas are clean, with no extra tap to find out.
  // Skipped entirely in halftone mode: the output is thousands of intended
  // dots, which the speck finder would (wrongly) treat as junk.
  const speckAnalysis = useMemo(
    () => (processedPreview && colorMode !== 'halftone' ? analyzeSpecks(processedPreview) : null),
    [processedPreview, colorMode]
  );

  // Per-component distance to the real artwork — the signal that separates a
  // junk floater (alone in open background) from detail hugging the design.
  const isolation = useMemo(
    () => (speckAnalysis ? computeIsolation(speckAnalysis, CONTENT_BIG) : null),
    [speckAnalysis]
  );

  // Two-tier overlay, available as soon as the preview is ready:
  //  · every loose floater (sitting out in open background) gets a FAINT
  //    amber marker — the passive "is the open space clean?" survey.
  //  · the subset the slider reaches flips to BRIGHT red.
  // Fragments hugging the artwork are never marked or erased — at any slider.
  const dotSurvey = useMemo<{
    overlay: ImageData | null; looseCount: number; removeCount: number;
  }>(() => {
    if (!speckAnalysis || !isolation) return { overlay: null, looseCount: 0, removeCount: 0 };
    const { width, height, labels, sizes, largestId } = speckAnalysis;
    // tier per component: 0 = ignore, 1 = surveyed (faint), 2 = will erase (red)
    const tier = new Uint8Array(sizes.length);
    let looseCount = 0, removeCount = 0;
    for (let i = 0; i < sizes.length; i++) {
      if (i === largestId) continue;
      const s = sizes[i];
      if (s < SURVEY_MIN || s > FRAGMENT_MAX) continue;
      const iso = isolation[i];
      const willRemove = iso >= isolationMin;       // within the slider's reach
      const isFloater = iso >= SURVEY_ISO;          // sitting in open background
      if (willRemove) { tier[i] = 2; removeCount++; looseCount++; }
      else if (isFloater) { tier[i] = 1; looseCount++; }
    }
    if (looseCount === 0) return { overlay: null, looseCount: 0, removeCount: 0 };
    const ov = new ImageData(width, height);
    const d = ov.data;
    for (let p = 0; p < labels.length; p++) {
      const lbl = labels[p];
      if (lbl < 0) continue;
      const t = tier[lbl];
      if (t === 0) continue;
      const o = p << 2;
      if (t === 2) { d[o] = 255; d[o + 1] = 30;  d[o + 2] = 30; d[o + 3] = 210; }
      else         { d[o] = 255; d[o + 1] = 190; d[o + 2] = 50; d[o + 3] = 90;  }
    }
    return { overlay: ov, looseCount, removeCount };
  }, [speckAnalysis, isolation, isolationMin]);

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

    // Dot survey: faint amber on every loose fragment, bright red on the ones
    // the slider will erase. Drawn whenever anything is loose — so the user
    // sees the state of the image without ever touching the slider.
    if (dotSurvey.overlay && bgMode !== 'original' && bgMode !== 'mask') {
      ctx.drawImage(imageDataToCanvas(dotSurvey.overlay), 0, 0);
    }

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
  }, [activePreview, bgMode, customBgColor, zoom, originalPreview, processedPreview, dotCleanup, dotSurvey]);

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
      // Detect on the raw design — its border is the real background color.
      // canvasData's border is mostly transparent platen, which is unreliable.
      const detectSrc = state.croppedImage ?? sourceImg;
      const detected = detectDominantShade(detectSrc, mode);
      if (detected) {
        setTargetColor(rgbToHex(...detected));
        setSensitivity(10);
        setSoftness(15);
      } else {
        setTargetColor(mode === 'dark' ? '#000000' : '#ffffff');
      }
      setShirtDetecting(null);
    }, 0);
  }, [sourceImg, state.croppedImage]);

  // Auto-detect the dominant background shade on first entry so the user
  // sees a meaningful preview immediately. Skipped on later batch images
  // if the user has already tuned settings — keeps their choices across
  // a batch instead of resetting per image. They can still tap Auto Black /
  // Auto White manually to re-detect.
  useEffect(() => {
    if (autoDetected || !sourceImg) return;
    setAutoDetected(true);
    if (!state.alphaUserTuned) {
      // Detect whether the background is light or dark first, instead of
      // always assuming dark — picks the right target on a white-bg image.
      autoDetectShirt(detectBackgroundShade(state.croppedImage ?? sourceImg));
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
      currentStep: 4,
    });
    goToStep(4);
  };

  // Apply the dot cleanup to a full-resolution result. Thresholds are tuned
  // in preview space, so scale them up by the preview/full ratio: distances
  // scale by 1/s, areas by 1/s². Mutates in place — the caller owns the
  // buffer — to avoid a second large allocation on 20+ MP images.
  const withDotCleanup = (img: ImageData): ImageData => {
    if (dotCleanup <= 0 || !previewSource) return img;
    const s = previewSource.width / img.width;
    const fullA = analyzeSpecks(img);
    const fullIso = computeIsolation(fullA, CONTENT_BIG / (s * s));
    removeSpecksInPlace(img, fullA, fullIso, isolationMin / s, FRAGMENT_MAX / (s * s));
    return img;
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
      const { prealpha, result } = await runAlpha(
        sourceImg, r, g, b, sensitivity,
        colorMode === 'halftone' ? halftoneFade : softness,
        colorMode, 100 - keepSolid, lpi, screenAngle,
      );
      updateState({
        // Halftone output is intentionally all tiny dots — the speck
        // cleaner would erase them, so skip it for that mode.
        canvasData: colorMode === 'halftone' ? result : withDotCleanup(result),
        prealphaCanvas: prealpha,
        alphaSettings: { targetColor: [r, g, b], alphaBase: sensitivity, alphaContrast: softness },
        alphaUserTuned: true,
        currentStep: 4,
      });
      goToStep(4);
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
        const final = colorMode === 'c2a'
          ? applyColorToAlpha(sourceImg, r, g, b, sensitivity, 100 - keepSolid)
          : colorMode === 'halftone'
          ? applyHalftone(sourceImg, r, g, b, sensitivity, halftoneFade, 300 / Math.max(1, lpi), screenAngle)
          : applyTrueColorToAlpha(sourceImg, r, g, b, sensitivity, softness);
        updateState({
          canvasData: colorMode === 'halftone' ? final : withDotCleanup(final),
          prealphaCanvas: sourceImg,
          alphaSettings: { targetColor: [r, g, b], alphaBase: sensitivity, alphaContrast: softness },
          alphaUserTuned: true,
          currentStep: 4,
        });
        goToStep(4);
      } catch (e) {
        console.error('Main-thread fallback also failed:', e);
        alert('Processing failed. Please try again — if it keeps happening, reload the page.');
      }
    } finally {
      setCommitting(false);
    }
  };

  // Tracks whether the user has set their own zoom. Once they have, automatic
  // re-fits triggered by layout changes leave their zoom alone.
  const userZoomedRef = useRef(false);
  // Last wrap width an auto-fit was computed against — lets us ignore
  // height-only layout changes.
  const lastFitWidthRef = useRef(0);

  // Fit the canvas to the available width. `force` (Fit button / new image)
  // clears the manual-zoom flag so auto-fitting is allowed again.
  const fitToScreen = useCallback((force = false) => {
    const wrap = canvasWrapRef.current;
    if (!wrap || !previewSource) return;
    const avail = wrap.clientWidth - 4; // small padding
    if (avail <= 0) return;
    if (force) userZoomedRef.current = false;
    lastFitWidthRef.current = avail;
    setZoom(clamp(avail / previewSource.width, 0.1, 4));
  }, [previewSource]);

  // Auto-fit once when a new image's preview arrives.
  useEffect(() => {
    userZoomedRef.current = false;
    lastFitWidthRef.current = 0;
    fitToScreen(true);
  }, [fitToScreen]);

  // Re-fit ONLY when the wrap's WIDTH actually changes (an orientation change),
  // and never once the user has chosen their own zoom. A height-only change —
  // e.g. the 'Original' info banner appearing and shrinking the canvas area —
  // must NOT touch zoom, so the original-vs-processed comparison stays locked
  // at the same magnification.
  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const avail = wrap.clientWidth - 4;
      if (avail <= 0 || Math.abs(avail - lastFitWidthRef.current) < 1) return;
      lastFitWidthRef.current = avail;
      if (!userZoomedRef.current) fitToScreen();
    });
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
    <div className="h-full flex flex-col gap-2">
      {/* Preview background + zoom */}
      <div className="flex items-center gap-1.5 bg-gray-800 rounded-lg px-2 py-1.5 flex-wrap shrink-0">
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
        <div className="flex-1" />
        <button onClick={() => { userZoomedRef.current = true; setZoom(z => Math.max(z / 1.4, 0.1)); }}
          className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" title="Zoom out"><ZoomOut size={14} /></button>
        <span className="text-xs text-gray-400 w-9 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <button onClick={() => { userZoomedRef.current = true; setZoom(z => Math.min(z * 1.4, 12)); }}
          className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" title="Zoom in"><ZoomIn size={14} /></button>
        <button onClick={() => fitToScreen(true)}
          className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition" title="Fit to screen"><Maximize2 size={12} /></button>
      </div>

      {/* Canvas — fills the space between the toolbar and the controls. */}
      <div ref={canvasWrapRef} className="flex-1 min-h-0 overflow-auto rounded-lg bg-gray-950">
        <div style={{
          width: scaledW > 0 ? scaledW : undefined,
          height: scaledH > 0 ? scaledH : undefined,
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

      {isOriginalView && (
        <div className="bg-amber-900/20 border border-amber-700/40 rounded px-3 py-1 text-xs text-amber-300 shrink-0 text-center">
          Showing the original image, before removal.
        </div>
      )}

      {/* Controls */}
      <div className="shrink-0 space-y-2">
        <div className="flex gap-2 items-center">
          <div className="w-9 h-9 rounded border-2 border-gray-600 shrink-0" style={{ background: targetColor }} />
          <input
            type="text"
            value={targetColor}
            onChange={e => { if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) { setTargetColor(e.target.value); updateState({ alphaUserTuned: true }); } }}
            className="w-24 px-2 py-2 bg-gray-700 border border-gray-600 rounded font-mono text-xs"
            maxLength={7}
          />
          <button
            onClick={() => { setEyedropperActive(a => !a); setHoveredColor(null); }}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded text-xs font-medium transition ${
              eyedropperActive ? 'bg-amber-600 hover:bg-amber-700 text-white' : 'bg-gray-700 hover:bg-gray-600'
            }`}
          >
            {eyedropperActive && hoveredColor
              ? <span className="w-3.5 h-3.5 rounded-sm border border-white/60 shrink-0" style={{ background: hoveredColor }} />
              : <Pipette size={13} />}
            {eyedropperActive ? (hoveredColor ?? 'Tap image…') : 'Pick'}
          </button>
          <button
            onClick={() => autoDetectShirt('dark')}
            disabled={!!shirtDetecting}
            className="flex-1 px-2 py-2 bg-gray-900 hover:bg-black border border-gray-600 rounded text-xs font-medium transition disabled:opacity-60"
          >
            {shirtDetecting === 'dark' ? '…' : 'Auto Black'}
          </button>
          <button
            onClick={() => autoDetectShirt('light')}
            disabled={!!shirtDetecting}
            className="flex-1 px-2 py-2 bg-gray-100 hover:bg-white text-gray-900 border border-gray-300 rounded text-xs font-medium transition disabled:opacity-60"
          >
            {shirtDetecting === 'light' ? '…' : 'Auto White'}
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {([
            ['solid', 'Solid Cut', 'Opaque interior'],
            ['c2a', 'Color to Alpha', 'Graded ink'],
            ['halftone', 'Halftone', 'Dot screen'],
          ] as const).map(([mode, label, sub]) => (
            <button
              key={mode}
              onClick={() => { setColorMode(mode); updateState({ alphaUserTuned: true }); }}
              className={`px-2 py-2 rounded-lg text-xs font-semibold leading-tight transition ${
                colorMode === mode ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'
              }`}
            >
              {label}
              <span className="block text-[10px] font-normal opacity-75">{sub}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <label className="text-sm font-semibold w-24 shrink-0">{colorMode === 'c2a' ? 'Transparency' : colorMode === 'halftone' ? 'Knockout' : 'Threshold'}</label>
          <input type="range" min="0" max="100" value={sensitivity}
            onChange={e => { setSensitivity(parseInt(e.target.value)); updateState({ alphaUserTuned: true }); }}
            className="flex-1 accent-blue-500" />
          <span className="font-mono text-blue-400 text-sm w-8 text-right tabular-nums">{sensitivity}</span>
        </div>

        {colorMode === 'solid' && (
          <div className="flex items-center gap-3">
            <label className="text-sm font-semibold w-24 shrink-0">Edge Soft</label>
            <input type="range" min="0" max="100" value={softness}
              onChange={e => { setSoftness(parseInt(e.target.value)); updateState({ alphaUserTuned: true }); }}
              className="flex-1 accent-blue-500" />
            <span className="font-mono text-blue-400 text-sm w-8 text-right tabular-nums">{softness}</span>
          </div>
        )}

        {colorMode === 'c2a' && (
          <div className="flex items-center gap-3">
            <label className="text-sm font-semibold w-24 shrink-0">Keep Solid</label>
            <input type="range" min="0" max="100" value={keepSolid}
              onChange={e => { setKeepSolid(parseInt(e.target.value)); updateState({ alphaUserTuned: true }); }}
              className="flex-1 accent-blue-500" />
            <span className="font-mono text-blue-400 text-sm w-8 text-right tabular-nums">{keepSolid}</span>
          </div>
        )}

        {colorMode === 'halftone' && (
          <>
            <div className="flex items-center gap-3">
              <label className="text-sm font-semibold w-24 shrink-0">Fade</label>
              <input type="range" min="0" max="100" value={halftoneFade}
                onChange={e => { setHalftoneFade(parseInt(e.target.value)); updateState({ alphaUserTuned: true }); }}
                className="flex-1 accent-blue-500" />
              <span className="font-mono text-blue-400 text-sm w-8 text-right tabular-nums">{halftoneFade}</span>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm font-semibold w-24 shrink-0">LPI</label>
              <input type="range" min="25" max="60" value={lpi}
                onChange={e => { setLpi(parseInt(e.target.value)); updateState({ alphaUserTuned: true }); }}
                className="flex-1 accent-blue-500" />
              <span className="font-mono text-sm w-16 text-right tabular-nums">
                <span className="text-blue-400">{lpi}</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm font-semibold w-24 shrink-0">Angle</label>
              <input type="range" min="0" max="90" value={screenAngle}
                onChange={e => { setScreenAngle(parseInt(e.target.value)); updateState({ alphaUserTuned: true }); }}
                className="flex-1 accent-blue-500" />
              <span className="font-mono text-blue-400 text-sm w-8 text-right tabular-nums">{screenAngle}°</span>
            </div>
            <p className="text-[11px] text-gray-500 leading-snug">
              Halftone output has no semi-transparent pixels — the fade is
              made of solid dots. Lower LPI = bigger dots.
            </p>
          </>
        )}

        {colorMode !== 'halftone' && (
          <div className="flex items-center gap-3">
            <label className="text-sm font-semibold w-24 shrink-0">Dot Cleanup</label>
            <input type="range" min="0" max="100" value={dotCleanup}
              onChange={e => setDotCleanup(parseInt(e.target.value))}
              className="flex-1 accent-red-500" />
            <span className="font-mono text-sm w-20 text-right tabular-nums">
              {!speckAnalysis ? (
                <span className="text-gray-500">…</span>
              ) : dotSurvey.looseCount === 0 ? (
                <span className="text-green-400">Clean</span>
              ) : dotCleanup === 0 ? (
                <span className="text-amber-400">{dotSurvey.looseCount} ●</span>
              ) : (
                <span className="text-red-400">{dotSurvey.removeCount}/{dotSurvey.looseCount} ●</span>
              )}
            </span>
          </div>
        )}

        <button onClick={proceed} disabled={committing}
          className="w-full px-4 py-3.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-xl font-semibold transition">
          {committing ? 'Processing full resolution…' : 'Continue'}
        </button>
        <button onClick={skipAlphaRemoval} disabled={committing}
          className="w-full py-1 text-xs text-gray-500 hover:text-gray-300 transition">
          Skip — image already has alpha
        </button>
      </div>
    </div>
  );
}
