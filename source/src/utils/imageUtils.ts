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