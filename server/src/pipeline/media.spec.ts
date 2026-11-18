import sharp from 'sharp';
import { sceneJpeg } from '../test-utils/images';
import { compressJpeg, convertToJpeg, resizeJpeg, UnprocessableImageError } from './media';

describe('media transforms', () => {
  it('converts a PNG with transparency to an sRGB JPEG with alpha flattened', async () => {
    const png = await sharp({
      create: { width: 600, height: 400, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer();

    const out = await convertToJpeg(png, 'image/png');
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.hasAlpha).toBe(false);
    expect([out.width, out.height]).toEqual([600, 400]);
  });

  it('applies EXIF orientation (portrait photo stored sideways comes out upright)', async () => {
    const sideways = await sharp(await sceneJpeg(800, 600))
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await convertToJpeg(sideways, 'image/jpeg');
    expect([out.width, out.height]).toEqual([600, 800]);
  });

  it('rejects undecodable input as unprocessable (no retry)', async () => {
    await expect(convertToJpeg(Buffer.from('not an image at all'), 'image/jpeg')).rejects.toBeInstanceOf(
      UnprocessableImageError,
    );
    await expect(convertToJpeg(Buffer.from('ftypheic-garbage'), 'image/heic')).rejects.toBeInstanceOf(
      UnprocessableImageError,
    );
  });

  it('compression keeps dimensions and makes the file smaller than the q95 master', async () => {
    const master = await convertToJpeg(await sceneJpeg(1600, 1200), 'image/jpeg');
    const out = await compressJpeg(master.data, 80);
    expect([out.width, out.height]).toEqual([1600, 1200]);
    expect(out.data.length).toBeLessThan(master.data.length);
  });

  it('resizes to fit inside the bound, preserving aspect ratio, never enlarging', async () => {
    const master = (await convertToJpeg(await sceneJpeg(2000, 1000), 'image/jpeg')).data;
    expect(await resizeJpeg(master, 256, 75)).toMatchObject({ width: 256, height: 128 });
    expect(await resizeJpeg(master, 4000, 80)).toMatchObject({ width: 2000, height: 1000 });
  });
});
