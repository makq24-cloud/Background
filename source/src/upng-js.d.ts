declare module 'upng-js' {
  const UPNG: {
    /**
     * Encode RGBA frames to a PNG ArrayBuffer.
     * @param bufs Array of frame buffers (RGBA, 8 bits/channel).
     * @param w Width in pixels.
     * @param h Height in pixels.
     * @param cnum Colour count — 0 for lossless, e.g. 256 for lossy quantization.
     * @param dels Per-frame delays (animation only).
     */
    encode(bufs: ArrayBuffer[], w: number, h: number, cnum: number, dels?: number[]): ArrayBuffer;
  };
  export default UPNG;
}
