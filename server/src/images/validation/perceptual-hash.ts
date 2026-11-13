/**
 * dHash (difference hash) over a 9x8 grayscale thumbnail -> 64 bits.
 * Each bit = "is this pixel brighter than its right-hand neighbour?"
 *
 * Robust to resizing, re-compression, and uniform brightness/contrast changes, which is
 * what "too similar" means for re-saved / screenshotted / slightly edited copies. More
 * robust than the old average-hash (aHash), which is thrown off by brightness gradients.
 *
 * Returned as a signed 64-bit bigint so it fits a Postgres BIGINT column, where
 * Hamming distance is computed in SQL: bit_count((a # b)::bit(64)).
 */
export const DHASH_WIDTH = 9;
export const DHASH_HEIGHT = 8;

export function dHashFromGray(gray: Uint8Array): bigint {
  if (gray.length !== DHASH_WIDTH * DHASH_HEIGHT) {
    throw new Error(`dHash expects ${DHASH_WIDTH}x${DHASH_HEIGHT} grayscale pixels, got ${gray.length}`);
  }
  let hash = 0n;
  for (let y = 0; y < DHASH_HEIGHT; y++) {
    for (let x = 0; x < DHASH_WIDTH - 1; x++) {
      const i = y * DHASH_WIDTH + x;
      hash = (hash << 1n) | (gray[i] > gray[i + 1] ? 1n : 0n);
    }
  }
  return BigInt.asIntN(64, hash);
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}
