export function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas 2D context');
  return ctx;
}

export function canvasToImageData(canvas: HTMLCanvasElement): ImageData {
  return get2dContext(canvas).getImageData(0, 0, canvas.width, canvas.height);
}

export function imageDataToCanvas(imageData: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  get2dContext(canvas).putImageData(imageData, 0, 0);
  return canvas;
}

export function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function drawImageToCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  get2dContext(canvas).drawImage(img, 0, 0);
  return canvas;
}

export function resizeImage(
  imageData: ImageData,
  targetWidth: number,
  targetHeight: number
): ImageData {
  const canvas = imageDataToCanvas(imageData);
  const resizedCanvas = document.createElement('canvas');
  resizedCanvas.width = targetWidth;
  resizedCanvas.height = targetHeight;
  const ctx = get2dContext(resizedCanvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
  return canvasToImageData(resizedCanvas);
}

export function centerImageOnCanvas(
  sourceImageData: ImageData,
  targetWidth: number,
  targetHeight: number
): ImageData {
  // Native canvas compositing — orders of magnitude faster than the manual
  // JS pixel loop and produces identical output.
  const target = document.createElement('canvas');
  target.width = targetWidth;
  target.height = targetHeight;
  const ctx = get2dContext(target);
  const src = imageDataToCanvas(sourceImageData);
  const offsetX = Math.floor((targetWidth - sourceImageData.width) / 2);
  const offsetY = Math.floor((targetHeight - sourceImageData.height) / 2);
  ctx.drawImage(src, offsetX, offsetY);
  return canvasToImageData(target);
}

export function cropImageData(
  imageData: ImageData,
  x: number,
  y: number,
  width: number,
  height: number
): ImageData {
  // Native crop via drawImage — much faster than the JS pixel loop.
  const target = document.createElement('canvas');
  target.width = width;
  target.height = height;
  const src = imageDataToCanvas(imageData);
  get2dContext(target).drawImage(src, x, y, width, height, 0, 0, width, height);
  return canvasToImageData(target);
}

export function detectBoundingBox(imageData: ImageData): { x: number; y: number; width: number; height: number } | null {
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;

  let minX = w, maxX = -1, minY = h, maxY = -1;
  let foundPixel = false;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) {
      const pixelIdx = i / 4;
      const x = pixelIdx % w;
      const y = Math.floor(pixelIdx / w);

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      foundPixel = true;
    }
  }

  if (!foundPixel) return null;

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

export function cloneImageData(imageData: ImageData): ImageData {
  const cloned = new ImageData(imageData.width, imageData.height);
  cloned.data.set(imageData.data);
  return cloned;
}

// Detects and crops a thin, near-uniform light-or-dark band hugging an edge —
// the residue AI upscalers leave behind, which the colour-to-alpha step then
// misses because it is a slightly different shade than the real background.
// Deliberately conservative: only trims a band that is thin (<=2% of the
// dimension), internally uniform, a consistent colour distinct from whatever
// sits just inside it, and overall near-white or near-black.
export function autoTrimEdges(img: ImageData): ImageData {
  const { width: W, height: H, data } = img;
  const UNIFORM = 20; // max channel spread tolerated within one line
  const DRIFT = 24;   // max colour drift allowed across the band
  const capH = Math.max(2, Math.floor(H * 0.02));
  const capW = Math.max(2, Math.floor(W * 0.02));

  // Mean colour + spread of the opaque pixels along one row or column.
  const lineStat = (along: 'row' | 'col', idx: number) => {
    let rs = 0, gs = 0, bs = 0, n = 0;
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    const len = along === 'row' ? W : H;
    for (let k = 0; k < len; k++) {
      const x = along === 'row' ? k : idx;
      const y = along === 'row' ? idx : k;
      const p = (y * W + x) * 4;
      if (data[p + 3] < 200) continue;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      rs += r; gs += g; bs += b; n++;
      if (r < rmin) rmin = r; if (r > rmax) rmax = r;
      if (g < gmin) gmin = g; if (g > gmax) gmax = g;
      if (b < bmin) bmin = b; if (b > bmax) bmax = b;
    }
    if (n < len * 0.6) return null; // mostly transparent — not an artifact band
    return {
      r: rs / n, g: gs / n, b: bs / n,
      spread: Math.max(rmax - rmin, gmax - gmin, bmax - bmin),
    };
  };

  const bandLen = (along: 'row' | 'col', fromStart: boolean, cap: number) => {
    const total = along === 'row' ? H : W;
    let count = 0, br = 0, bg = 0, bb = 0;
    for (let step = 0; step <= cap; step++) {
      const idx = fromStart ? step : total - 1 - step;
      const s = lineStat(along, idx);
      if (!s || s.spread > UNIFORM) break;
      if (count === 0) { br = s.r; bg = s.g; bb = s.b; }
      else if (Math.abs(s.r - br) + Math.abs(s.g - bg) + Math.abs(s.b - bb) > DRIFT) break;
      count++;
    }
    if (count === 0 || count > cap) return 0; // none, or band overflows the cap
    const lo = Math.min(br, bg, bb), hi = Math.max(br, bg, bb);
    if (lo < 190 && hi > 70) return 0; // not near-white and not near-black — leave it
    return count;
  };

  const top = bandLen('row', true, capH);
  const bottom = bandLen('row', false, capH);
  const left = bandLen('col', true, capW);
  const right = bandLen('col', false, capW);

  if (!top && !bottom && !left && !right) return img;
  const nw = W - left - right;
  const nh = H - top - bottom;
  if (nw < W * 0.5 || nh < H * 0.5) return img; // safety — never trim that aggressively
  return cropImageData(img, left, top, nw, nh);
}