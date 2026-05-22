import { applyTrueColorToAlphaInPlace } from './alphaEngine';

export type AlphaRequest = {
  id: number;
  sourceBuf: ArrayBuffer;
  width: number;
  height: number;
  r: number;
  g: number;
  b: number;
  threshold: number;
  softness: number;
};

export type AlphaResponse =
  | { id: number; ok: true; sourceBuf: ArrayBuffer; resultBuf: ArrayBuffer; width: number; height: number }
  | { id: number; ok: false; error: string };

self.onmessage = (e: MessageEvent<AlphaRequest>) => {
  const { id, sourceBuf, width, height, r, g, b, threshold, softness } = e.data;

  try {
    // Allocate a fresh result buffer of the same size and seed it with the
    // source bytes — the algorithm mutates in place, so we copy first.
    const resultBuf = new ArrayBuffer(sourceBuf.byteLength);
    const resultView = new Uint8ClampedArray(resultBuf);
    resultView.set(new Uint8ClampedArray(sourceBuf));

    applyTrueColorToAlphaInPlace(resultView, r, g, b, threshold, softness);

    // Transfer BOTH buffers back so the main thread can rebuild the original
    // source (now needed as prealphaCanvas) without a clone, plus the result.
    const reply: AlphaResponse = { id, ok: true, sourceBuf, resultBuf, width, height };
    (self as unknown as Worker).postMessage(reply, [sourceBuf, resultBuf]);
  } catch (err) {
    const reply: AlphaResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(reply);
  }
};
