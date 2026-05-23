// Connected-component analysis of opaque regions — used to find and remove
// the tiny floating specks that background removal leaves behind (shirt
// texture noise that wasn't a pure background color).

export type SpeckAnalysis = {
  labels: Int32Array;   // pixel index -> component id (-1 = transparent)
  sizes: number[];      // component id -> area in pixels
  spots: { cx: number; cy: number; r: number }[]; // centre + radius per component
  width: number;
  height: number;
  largestId: number;
};

// A pixel counts as "present" if it's more than faintly opaque. Feathered
// edges have partial alpha; anything above this is treated as solid.
const ALPHA_PRESENT = 12;

// 8-connected flood fill labelling. One pass; each pixel is visited once.
export function analyzeSpecks(img: ImageData): SpeckAnalysis {
  const { width, height, data } = img;
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const spots: { cx: number; cy: number; r: number }[] = [];
  const stack: number[] = [];
  let largestId = -1;
  let largestSize = 0;

  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1 || data[(start << 2) + 3] <= ALPHA_PRESENT) continue;

    const id = sizes.length;
    let size = 0;
    let minx = width, miny = height, maxx = 0, maxy = 0;

    stack.length = 0;
    stack.push(start);
    labels[start] = id;

    while (stack.length > 0) {
      const p = stack.pop() as number;
      size++;
      const px = p % width;
      const py = (p / width) | 0;
      if (px < minx) minx = px;
      if (px > maxx) maxx = px;
      if (py < miny) miny = py;
      if (py > maxy) maxy = py;

      const xLo = px > 0 ? -1 : 0;
      const xHi = px < width - 1 ? 1 : 0;
      const yLo = py > 0 ? -1 : 0;
      const yHi = py < height - 1 ? 1 : 0;
      for (let dy = yLo; dy <= yHi; dy++) {
        for (let dx = xLo; dx <= xHi; dx++) {
          if (dx === 0 && dy === 0) continue;
          const q = p + dy * width + dx;
          if (labels[q] !== -1 || data[(q << 2) + 3] <= ALPHA_PRESENT) continue;
          labels[q] = id;
          stack.push(q);
        }
      }
    }

    sizes.push(size);
    spots.push({
      cx: (minx + maxx) / 2,
      cy: (miny + maxy) / 2,
      r: Math.max(maxx - minx, maxy - miny) / 2,
    });
    if (size > largestSize) { largestSize = size; largestId = id; }
  }

  return { labels, sizes, spots, width, height, largestId };
}

// Component ids that count as removable specks at the given size limit. The
// single largest component (the main artwork) is never a speck.
export function speckIds(a: SpeckAnalysis, maxArea: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < a.sizes.length; i++) {
    if (i !== a.largestId && a.sizes[i] <= maxArea) ids.push(i);
  }
  return ids;
}

// A copy of the image with every speck component erased (alpha -> 0).
export function removeSpecks(img: ImageData, a: SpeckAnalysis, maxArea: number): ImageData {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const remove = speckIds(a, maxArea);
  if (remove.length === 0) return out;
  const isSpeck = new Uint8Array(a.sizes.length);
  for (const id of remove) isSpeck[id] = 1;

  const d = out.data;
  const labels = a.labels;
  for (let p = 0; p < labels.length; p++) {
    const lbl = labels[p];
    if (lbl >= 0 && isSpeck[lbl]) d[(p << 2) + 3] = 0;
  }
  return out;
}

// Same as removeSpecks but mutates the image in place — no full-image copy.
// Use when the caller owns the buffer (e.g. a fresh worker result), to avoid
// a second ~W*H*4 allocation on large full-resolution images.
export function removeSpecksInPlace(img: ImageData, a: SpeckAnalysis, maxArea: number): void {
  const remove = speckIds(a, maxArea);
  if (remove.length === 0) return;
  const isSpeck = new Uint8Array(a.sizes.length);
  for (const id of remove) isSpeck[id] = 1;
  const d = img.data;
  const labels = a.labels;
  for (let p = 0; p < labels.length; p++) {
    const lbl = labels[p];
    if (lbl >= 0 && isSpeck[lbl]) d[(p << 2) + 3] = 0;
  }
}
