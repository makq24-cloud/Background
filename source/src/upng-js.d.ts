declare module 'upng-js' {
  /** A leaf node of upng-js's median-cut quantizer. */
  interface UPNGQuantLeaf {
    /** Packed straight-alpha colour, 0xAABBGGRR. */
    est: { rgba: number };
  }
  const UPNG: {
    /**
     * Encode RGBA frames to a PNG ArrayBuffer.
     * @param bufs Array of frame buffers (RGBA, 8 bits/channel).
     * @param w Width in pixels.
     * @param h Height in pixels.
     * @param cnum Colour count — 0 for lossless (auto-uses an indexed PNG when
     *   the image already has <=256 unique colours), e.g. 256 for lossy
     *   quantization.
     * @param dels Per-frame delays (animation only).
     */
    encode(bufs: ArrayBuffer[], w: number, h: number, cnum: number, dels?: number[]): ArrayBuffer;
    /**
     * Median-cut RGBA quantization. Returns the quantized frame buffers and
     * the palette as leaf nodes (each leaf's `est.rgba` is a packed colour).
     */
    quantize(bufs: ArrayBuffer[], psize: number, roundAlpha?: boolean): {
      bufs: ArrayBuffer[];
      plte: UPNGQuantLeaf[];
    };
  };
  export default UPNG;
}
