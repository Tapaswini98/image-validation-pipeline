import sharp from 'sharp';
import { CorruptImageError, decodeImage } from './image-decoder';
import { hammingDistance } from '../validation/perceptual-hash';
import { asPng, blurred, resized, sceneJpeg } from '../../test-utils/images';

describe('decodeImage', () => {
  it('normalises dimensions, keeps PNG as PNG, produces a thumbnail and face-detection input', async () => {
    const png = await asPng(await sceneJpeg(1200, 900));
    const d = await decodeImage(png, 'image/png');
    expect(d).toMatchObject({ width: 1200, height: 900, processedMimeType: 'image/png' });
    expect((await sharp(d.thumbnail).metadata()).width).toBe(400);
    expect((await sharp(d.faceDetectionInput).metadata()).format).toBe('jpeg');
  });

  it('applies EXIF orientation and strips metadata (GPS, camera) from the output', async () => {
    const rotated = await sharp(await sceneJpeg(800, 600))
      .withMetadata({ orientation: 6 }) // "rotate 90° CW" as phones write it
      .jpeg()
      .toBuffer();
    const d = await decodeImage(rotated, 'image/jpeg');
    expect([d.width, d.height]).toEqual([600, 800]);
    const meta = await sharp(d.processed).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('scores a sharp image far above the same image blurred (Laplacian variance)', async () => {
    const sharpImg = await sceneJpeg(1200, 1200);
    const sharpScore = (await decodeImage(sharpImg, 'image/jpeg')).blurScore;
    const blurScore = (await decodeImage(await blurred(sharpImg), 'image/jpeg')).blurScore;
    expect(sharpScore).toBeGreaterThan(40); // default BLUR_THRESHOLD
    expect(blurScore).toBeLessThan(40);
    expect(sharpScore / blurScore).toBeGreaterThan(10);
  });

  it('gives near-identical perceptual hashes for a resized/re-compressed copy, distant ones for a different image', async () => {
    const a = await sceneJpeg(1200, 900, 1);
    const aSmall = await resized(a, 700);
    const b = await sceneJpeg(1200, 900, 5);
    const [ha, haSmall, hb] = await Promise.all(
      [a, aSmall, b].map(async (img) => (await decodeImage(img, 'image/jpeg')).perceptualHash),
    );
    expect(hammingDistance(ha, haSmall)).toBeLessThanOrEqual(6); // default SIMILARITY_MAX_HAMMING
    expect(hammingDistance(ha, hb)).toBeGreaterThan(6);
  });

  it('throws CorruptImageError for bytes that look like a JPEG but are not decodable', async () => {
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
    await expect(decodeImage(corrupt, 'image/jpeg')).rejects.toBeInstanceOf(CorruptImageError);
  });

  it('throws CorruptImageError for an invalid HEIC payload', async () => {
    await expect(decodeImage(Buffer.from('ftypheic-garbage'), 'image/heic')).rejects.toBeInstanceOf(
      CorruptImageError,
    );
  });
});
