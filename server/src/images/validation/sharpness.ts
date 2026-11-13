/**
 * Variance of the Laplacian: the standard focus measure (Pech-Pacheco et al., also what
 * OpenCV tutorials use). The Laplacian kernel responds to edges; a sharp image has many
 * strong edges -> high variance; a blurry image has soft edges -> low variance.
 *
 * Why not "pixel standard deviation" (the previous approach)? That measures CONTRAST, not focus:
 * a sharp photo of a plain wall scores low, and a blurry high-contrast photo scores high.
 *
 *   kernel:  0  1  0
 *            1 -4  1
 *            0  1  0
 *
 * Input is a grayscale buffer (1 byte per pixel). Callers normalise the image to a fixed
 * size first so scores are comparable across resolutions.
 */
export function laplacianVariance(
  gray: Uint8Array,
  width: number,
  height: number,
  region = { x0: 0, y0: 0, x1: width, y1: height },
): number {
  const xStart = Math.max(1, region.x0);
  const yStart = Math.max(1, region.y0);
  const xEnd = Math.min(width - 1, region.x1);
  const yEnd = Math.min(height - 1, region.y1);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = yStart; y < yEnd; y++) {
    const row = y * width;
    for (let x = xStart; x < xEnd; x++) {
      const i = row + x;
      const lap = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Sharpness of the sharpest region (grid x grid tiles).
 *
 * A whole-image score wrongly rejects portraits with a deliberately blurred background
 * (bokeh): the face is sharp but most pixels aren't. What matters is whether the SUBJECT
 * is in focus, so we score the best tile. An out-of-focus or motion-blurred photo is soft
 * everywhere and still fails. (Next step: score the detected face box directly.)
 */
export function regionalSharpness(gray: Uint8Array, width: number, height: number, grid = 4): number {
  const tileW = Math.floor(width / grid);
  const tileH = Math.floor(height / grid);
  if (tileW < 8 || tileH < 8) return laplacianVariance(gray, width, height);
  let best = 0;
  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      const region = { x0: tx * tileW, y0: ty * tileH, x1: (tx + 1) * tileW, y1: (ty + 1) * tileH };
      best = Math.max(best, laplacianVariance(gray, width, height, region));
    }
  }
  return best;
}
