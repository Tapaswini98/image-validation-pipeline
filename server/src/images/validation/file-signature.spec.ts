import { detectImageType } from './file-signature';
import { asPng, heicHeader, sceneJpeg } from '../../test-utils/images';

describe('detectImageType (magic bytes)', () => {
  it('detects JPEG and PNG from content', async () => {
    const jpeg = await sceneJpeg(64, 64);
    expect(detectImageType(jpeg)).toBe('image/jpeg');
    expect(detectImageType(await asPng(jpeg))).toBe('image/png');
  });

  it('detects HEIC by ftyp brand, including generic mif1 with a heic compatible brand', () => {
    expect(detectImageType(heicHeader('heic'))).toBe('image/heic');
    expect(detectImageType(heicHeader('heix'))).toBe('image/heic');
    expect(detectImageType(heicHeader('mif1', ['mif1', 'heic']))).toBe('image/heic');
  });

  it('rejects AVIF (same container, different codec)', () => {
    expect(detectImageType(heicHeader('avif', ['avif', 'mif1']))).toBeNull();
    expect(detectImageType(heicHeader('mif1', ['mif1', 'avif']))).toBeNull();
  });

  it.each([
    ['GIF', Buffer.from('GIF89a......')],
    ['WebP', Buffer.from('RIFF....WEBPVP8 ')],
    ['text renamed to .jpg', Buffer.from('hello, I am not an image')],
    ['PDF', Buffer.from('%PDF-1.7')],
    ['empty', Buffer.alloc(0)],
    ['truncated JPEG', Buffer.from([0xff, 0xd8])],
  ])('rejects %s', (_label, buf) => {
    expect(detectImageType(buf)).toBeNull();
  });
});
