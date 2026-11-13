import sharp from 'sharp';
import { laplacianVariance, regionalSharpness } from './sharpness';
import { blurred, sceneJpeg } from '../../test-utils/images';

async function gray(img: Buffer) {
  const { data, info } = await sharp(img).grayscale().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

describe('sharpness', () => {
  it('is zero for a flat image (no edges)', () => {
    expect(laplacianVariance(new Uint8Array(100 * 100).fill(128), 100, 100)).toBe(0);
  });

  it('drops sharply when an image is blurred', async () => {
    const img = await sceneJpeg(800, 800);
    const a = await gray(img);
    const b = await gray(await blurred(img));
    expect(laplacianVariance(a.data, a.w, a.h)).toBeGreaterThan(10 * laplacianVariance(b.data, b.w, b.h));
  });

  it('does not penalise a portrait-style photo with a blurred background (bokeh) when the subject is sharp', async () => {
    // Blurred background with a sharp 200x200 "subject" composited in the middle.
    const background = await blurred(await sceneJpeg(800, 800, 2), 15);
    const subject = await sharp(await sceneJpeg(800, 800, 4))
      .extract({ left: 300, top: 300, width: 200, height: 200 })
      .toBuffer();
    const portrait = await sharp(background)
      .composite([{ input: subject, left: 300, top: 300 }])
      .jpeg()
      .toBuffer();
    const fullyBlurred = await blurred(portrait, 15);

    const p = await gray(portrait);
    const f = await gray(fullyBlurred);
    const portraitScore = regionalSharpness(p.data, p.w, p.h);
    const blurredScore = regionalSharpness(f.data, f.w, f.h);

    // Whole-image variance is dragged down by the background; the regional score is not.
    expect(portraitScore).toBeGreaterThan(laplacianVariance(p.data, p.w, p.h) * 2);
    expect(portraitScore).toBeGreaterThan(40);
    expect(blurredScore).toBeLessThan(40);
  });
});
