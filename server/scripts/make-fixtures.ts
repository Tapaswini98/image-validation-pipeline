/**
 * Generates QA files for the rejection paths that are awkward to find as real photos.
 *   npm run fixtures            -> writes to ./fixtures
 *
 * Real-photo cases (faces, group shots, HEIC from an iPhone) still need real photos.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { blurred, sceneJpeg } from '../src/test-utils/images';

async function main() {
  const dir = process.argv[2] ?? 'fixtures';
  mkdirSync(dir, { recursive: true });
  const write = (name: string, data: Buffer) => {
    writeFileSync(join(dir, name), data);
    console.log(`  ${name.padEnd(28)} ${(data.length / 1024).toFixed(0).padStart(6)} KB`);
  };

  const scene = await sceneJpeg(1600, 1600, 1);
  write('sharp-scene.jpg', scene); // passes format/size/blur checks; Rekognition then rejects it (no face)
  write('sharp-scene-resized-copy.png', await sharp(scene).resize(1000).png().toBuffer()); // DUPLICATE
  write('sharp-scene-recompressed.jpg', await sharp(scene).jpeg({ quality: 60 }).toBuffer()); // DUPLICATE
  write('different-scene.jpg', await sceneJpeg(1600, 1600, 7)); // accepted (not similar)
  write('blurry.jpg', await blurred(await sceneJpeg(1600, 1600, 3))); // BLURRY
  write(
    'low-resolution-400.jpg',
    await sharp(await sceneJpeg(400, 400, 4))
      .jpeg({ quality: 100 })
      .toBuffer(),
  ); // RESOLUTION_TOO_LOW
  write(
    'tiny-file.jpg',
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#999' } })
      .jpeg()
      .toBuffer(),
  ); // FILE_TOO_SMALL
  write('text-renamed.jpg', Buffer.from('not an image '.repeat(2000))); // UNSUPPORTED_FORMAT (server)
  write('animated.gif', await sharp(scene).resize(800).gif().toBuffer()); // UNSUPPORTED_FORMAT (client)
  write('photo.webp', await sharp(scene).webp().toBuffer()); // UNSUPPORTED_FORMAT (client)
  write('corrupt.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30_000, 7)])); // CORRUPT_IMAGE
  write(
    'exif-rotated.jpg',
    await sharp(await sceneJpeg(1600, 1200, 5))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer(),
  ); // stored upright as 1200x1600, EXIF stripped
  console.log(`\nWrote QA fixtures to ${dir}/`);
}

void main();
