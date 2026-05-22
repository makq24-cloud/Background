import type { AlphaRequest, AlphaResponse } from './alphaWorker';

let workerInstance: Worker | null = null;
let nextId = 1;
const pending = new Map<number, {
  resolve: (v: { prealpha: ImageData; result: ImageData }) => void;
  reject: (err: Error) => void;
}>();

function getWorker(): Worker {
  if (workerInstance) return workerInstance;

  // Vite handles bundling and the module-worker setup via this URL form;
  // works in dev, build, and on iOS Safari which supports module workers.
  workerInstance = new Worker(new URL('./alphaWorker.ts', import.meta.url), {
    type: 'module',
  });

  workerInstance.onmessage = (e: MessageEvent<AlphaResponse>) => {
    const msg = e.data;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);

    if (!msg.ok) {
      entry.reject(new Error(msg.error));
      return;
    }

    const { sourceBuf, resultBuf, width, height } = msg;
    const prealpha = new ImageData(new Uint8ClampedArray(sourceBuf), width, height);
    const result   = new ImageData(new Uint8ClampedArray(resultBuf), width, height);
    entry.resolve({ prealpha, result });
  };

  workerInstance.onerror = (e) => {
    // Fail every pending request — they can't recover individually.
    const err = new Error(e.message || 'Alpha worker crashed');
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
    // Drop the worker so the next call gets a fresh one.
    workerInstance?.terminate();
    workerInstance = null;
  };

  return workerInstance;
}

/**
 * Run color-to-alpha off the main thread.
 *
 * The caller's `source` ImageData WILL have its underlying buffer
 * neutered (transferred to the worker). Don't read from it after calling.
 * The returned `prealpha` is a fresh ImageData backed by the same bytes —
 * use that wherever you would have used the original source.
 */
export function runAlpha(
  source: ImageData,
  r: number,
  g: number,
  b: number,
  threshold: number,
  softness: number,
): Promise<{ prealpha: ImageData; result: ImageData }> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });

    const req: AlphaRequest = {
      id,
      sourceBuf: source.data.buffer,
      width: source.width,
      height: source.height,
      r, g, b, threshold, softness,
    };

    try {
      getWorker().postMessage(req, [req.sourceBuf]);
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
