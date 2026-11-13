declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array | ArrayBuffer;
    format: 'JPEG' | 'PNG';
    quality?: number; // 0..1, JPEG only
  }
  function convert(options: ConvertOptions): Promise<ArrayBuffer>;
  export default convert;
}
