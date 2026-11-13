import sharp from 'sharp';

/**
 * Synthetic fixtures generated on the fly: no binary files in the repo, and each test
 * says exactly what property of the image it depends on.
 */

/** A detailed, in-focus "scene": shapes + fine texture -> strong edges. */
export async function sceneJpeg(width: number, height: number, variant = 0): Promise<Buffer> {
  const shapes = Array.from({ length: 12 }, (_, i) => {
    const seed = (i + 1) * (variant + 3);
    const x = (seed * 97) % width;
    const y = (seed * 53) % height;
    const r = 20 + ((seed * 31) % Math.max(30, Math.floor(Math.min(width, height) / 5)));
    const shade = (seed * 67) % 255;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="rgb(${shade},${255 - shade},${(shade * 3) % 255})"/>`;
  }).join('');
  const stripes = Array.from(
    { length: Math.ceil(width / 8) },
    (_, i) => `<rect x="${i * 8}" y="0" width="3" height="${height}" fill="rgba(0,0,0,0.25)"/>`,
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="rgb(${(variant * 40) % 255},120,200)"/>${stripes}${shapes}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

export async function blurred(image: Buffer, sigma = 12): Promise<Buffer> {
  return sharp(image).blur(sigma).jpeg({ quality: 92 }).toBuffer();
}

export async function asPng(image: Buffer): Promise<Buffer> {
  return sharp(image).png().toBuffer();
}

export async function resized(image: Buffer, width: number): Promise<Buffer> {
  return sharp(image).resize(width).jpeg({ quality: 80 }).toBuffer();
}

/** Minimal ISO-BMFF header as written by iPhones (major brand "heic"). */
export function heicHeader(major = 'heic', compatible: string[] = ['mif1', 'heic']): Buffer {
  const size = 16 + compatible.length * 4;
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);
  buf.write('ftyp', 4, 'ascii');
  buf.write(major, 8, 'ascii');
  compatible.forEach((b, i) => buf.write(b, 16 + i * 4, 'ascii'));
  return buf;
}
