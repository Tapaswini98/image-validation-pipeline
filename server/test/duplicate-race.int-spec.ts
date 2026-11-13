import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ImageRepository } from '../src/images/image.repository';

/**
 * Integration test against the real Postgres from docker-compose (npm run test:int).
 * Proves the fix for the old bug: N near-identical photos finishing at the same time
 * must yield exactly ONE accepted image, not N.
 */
describe('ImageRepository.acceptIfUnique (real Postgres)', () => {
  const prisma = new PrismaService();
  const repo = new ImageRepository(prisma);

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  async function seedProcessing(
    collectionId: string,
    n: number,
    hash: { content: (i: number) => string; phash: (i: number) => bigint },
  ) {
    const ids = Array.from({ length: n }, () => randomUUID());
    await prisma.image.createMany({
      data: ids.map((id, i) => ({
        id,
        collectionId,
        originalFilename: `photo-${i}.jpg`,
        sizeBytes: 1000,
        status: 'PROCESSING' as const,
        contentHash: hash.content(i),
      })),
    });
    return ids.map((id, i) => ({ id, phash: hash.phash(i), contentHash: hash.content(i) }));
  }

  const accept = (collectionId: string, img: { id: string; phash: bigint; contentHash: string }) =>
    repo.acceptIfUnique(
      img.id,
      {
        collectionId,
        excludeId: img.id,
        contentHash: img.contentHash,
        perceptualHash: img.phash,
        maxDistance: 6,
      },
      { perceptualHash: img.phash },
    );

  it('accepts exactly one of 10 concurrent near-duplicates (phash differs by 1-2 bits)', async () => {
    const collectionId = randomUUID();
    const base = 0x0f0f_1234_abcd_5678n;
    const images = await seedProcessing(collectionId, 10, {
      content: () => randomUUID().replace(/-/g, '').padEnd(64, '0'), // different bytes
      phash: (i) => BigInt.asIntN(64, base ^ BigInt(i % 3)), // visually the same
    });

    const results = await Promise.all(images.map((img) => accept(collectionId, img)));

    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    const statuses = await prisma.image.groupBy({
      by: ['status', 'rejectionCode'],
      where: { collectionId },
      _count: true,
    });
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'ACCEPTED', _count: 1 }),
        expect.objectContaining({ status: 'REJECTED', rejectionCode: 'DUPLICATE', _count: 9 }),
      ]),
    );
  });

  it('accepts visually different photos concurrently', async () => {
    const collectionId = randomUUID();
    const images = await seedProcessing(collectionId, 5, {
      content: () => randomUUID().replace(/-/g, '').padEnd(64, '0'),
      phash: (i) => BigInt.asIntN(64, BigInt(0x00ff) << BigInt(i * 12)), // far apart
    });
    const results = await Promise.all(images.map((img) => accept(collectionId, img)));
    expect(results.every((r) => r.accepted)).toBe(true);
  });

  it('scopes duplicates to a collection: the same photo is fine for two different users', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const same = { content: () => 'f'.repeat(64), phash: () => 42n };
    const [imgA] = await seedProcessing(a, 1, same);
    const [imgB] = await seedProcessing(b, 1, same);
    const results = await Promise.all([accept(a, imgA), accept(b, imgB)]);
    expect(results.every((r) => r.accepted)).toBe(true);
  });

  it('the partial unique index blocks a second ACCEPTED row with identical content, even bypassing the app', async () => {
    const collectionId = randomUUID();
    const make = () => ({
      id: randomUUID(),
      collectionId,
      originalFilename: 'x.jpg',
      sizeBytes: 1,
      status: 'ACCEPTED' as const,
      contentHash: 'e'.repeat(64),
    });
    await prisma.image.create({ data: make() });
    await expect(prisma.image.create({ data: make() })).rejects.toMatchObject({ code: 'P2002' });
  });
});
