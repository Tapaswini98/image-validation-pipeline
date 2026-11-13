import { dHashFromGray, hammingDistance } from './perceptual-hash';

describe('dHash', () => {
  it('produces a signed 64-bit value that fits Postgres BIGINT', () => {
    const descending = Uint8Array.from({ length: 72 }, (_, i) => 255 - (i % 9) * 20); // every bit = 1
    const hash = dHashFromGray(descending);
    expect(hash).toBe(-1n);
    expect(hash >= -(2n ** 63n) && hash < 2n ** 63n).toBe(true);
  });

  it('is invariant to uniform brightness changes', () => {
    const base = Uint8Array.from({ length: 72 }, (_, i) => (i * 37) % 200);
    const brighter = base.map((v) => v + 40);
    expect(hammingDistance(dHashFromGray(base), dHashFromGray(brighter))).toBe(0);
  });

  it('rejects wrong-sized input', () => {
    expect(() => dHashFromGray(new Uint8Array(64))).toThrow();
  });
});

describe('hammingDistance', () => {
  it.each([
    [0n, 0n, 0],
    [0n, 1n, 1],
    [0n, -1n, 64], // all 64 bits differ
    [0b1011n, 0b0110n, 3],
  ])('distance(%s, %s) = %s', (a, b, expected) => {
    expect(hammingDistance(a, b)).toBe(expected);
  });
});
