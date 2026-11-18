import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { PipelineStage } from '@prisma/client';
import { loadEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';
import type { StorageService } from '../src/storage/storage.service';
import { PipelineRepository } from '../src/pipeline/pipeline.repository';
import { PipelineService } from '../src/pipeline/pipeline.service';
import { PipelineStagesService } from '../src/pipeline/pipeline-stages.service';
import type { PipelineQueue, StageJobData } from '../src/pipeline/pipeline.queue';
import { sceneJpeg } from '../src/test-utils/images';

/**
 * Real Postgres (npm run test:int), real image transforms; S3 and Redis are in-memory fakes.
 * Proves the idempotency claims: duplicate deliveries, stale messages from an older run and
 * reprocessing never corrupt state or create duplicate variants.
 */
describe('media pipeline idempotency (real Postgres)', () => {
  const prisma = new PrismaService();
  const env = loadEnv();
  const repo = new PipelineRepository(prisma);

  const objects = new Map<string, Buffer>();
  const storage = {
    get: jest.fn((key: string) => {
      const obj = objects.get(key);
      if (!obj) return Promise.reject(Object.assign(new Error(`NoSuchKey ${key}`), { name: 'NoSuchKey' }));
      return Promise.resolve(obj);
    }),
    put: jest.fn((key: string, body: Buffer) => {
      objects.set(key, body);
      return Promise.resolve();
    }),
    objectUrl: (key: string) => `https://bucket.s3.test.amazonaws.com/${key}`,
  };

  let sent: { stage: PipelineStage; data: StageJobData }[] = [];
  const queue = {
    enqueue: jest.fn((stage: PipelineStage, data: StageJobData) => {
      sent.push({ stage, data });
      return Promise.resolve();
    }),
  };

  const stages = new PipelineStagesService(
    repo,
    storage as unknown as StorageService,
    queue as unknown as PipelineQueue,
    env,
  );
  const pipeline = new PipelineService(repo, queue as unknown as PipelineQueue);

  /** Drain the fake queue like the three workers would. */
  async function drain() {
    while (sent.length) {
      const { stage, data } = sent.shift()!;
      if (stage === 'CONVERSION') await stages.convert(data);
      if (stage === 'COMPRESSION') await stages.compress(data);
      if (stage === 'VARIANTS') await stages.generateVariants(data);
    }
  }

  async function seedAccepted(original: Buffer) {
    const id = randomUUID();
    const originalKey = `originals/${id}`;
    objects.set(originalKey, original);
    await prisma.image.create({
      data: {
        id,
        collectionId: randomUUID(),
        originalFilename: 'p.jpg',
        sizeBytes: original.length,
        status: 'ACCEPTED',
        detectedMimeType: 'image/jpeg',
        originalKey,
      },
    });
    return id;
  }

  const variantsOf = (imageId: string) =>
    prisma.imageVariant.findMany({ where: { imageId }, orderBy: { kind: 'asc' } });

  let photo: Buffer;
  beforeAll(async () => {
    await prisma.$connect();
    photo = await sceneJpeg(1600, 1200);
  });
  beforeEach(() => {
    sent = [];
  });
  afterAll(() => prisma.$disconnect());

  it('runs conversion -> compression -> variants and records sizes, ratio and three variants', async () => {
    const id = await seedAccepted(photo);
    await pipeline.start(id);
    await drain();

    const job = await repo.find(id);
    expect(job).toMatchObject({ status: 'COMPLETED', run: 1, width: 1600, height: 1200 });
    expect(job!.compressionRatio).toBeGreaterThan(1);
    expect(job!.compressedBytes).toBeLessThan(job!.convertedBytes!);

    const variants = await variantsOf(id);
    expect(variants.map((v) => [v.kind, v.width, v.key])).toEqual([
      ['THUMBNAIL', 256, `variants/${id}/thumbnail.jpg`],
      ['WEB', 1280, `variants/${id}/web.jpg`],
      ['FULL', 1600, `variants/${id}/full.jpg`],
    ]);
  });

  it('duplicate deliveries of every stage are skipped: no duplicate variants, state unchanged', async () => {
    const id = await seedAccepted(photo);
    await pipeline.start(id);
    await drain();
    const before = await repo.find(id);

    await expect(stages.convert({ imageId: id, run: 1 })).resolves.toBe('SKIPPED');
    await expect(stages.compress({ imageId: id, run: 1 })).resolves.toBe('SKIPPED');
    await expect(stages.generateVariants({ imageId: id, run: 1 })).resolves.toBe('SKIPPED');
    await pipeline.start(id); // e.g. validation retried after the accept

    expect(sent).toEqual([]);
    expect(await repo.find(id)).toEqual(before);
    expect(await variantsOf(id)).toHaveLength(3);
  });

  it('reprocess runs a new run, ignores stale messages from the old run, still exactly 3 variants', async () => {
    const id = await seedAccepted(photo);
    await pipeline.start(id);
    await drain();
    const firstKeys = (await variantsOf(id)).map((v) => v.key);

    const reset = await pipeline.reprocess(id);
    expect(reset).toMatchObject({ status: 'QUEUED', run: 2 });

    // A late message from run 1 arrives while run 2 is queued: must not touch run 2.
    await expect(stages.convert({ imageId: id, run: 1 })).resolves.toBe('SKIPPED');

    await drain();
    expect(await repo.find(id)).toMatchObject({ status: 'COMPLETED', run: 2 });
    const variants = await variantsOf(id);
    expect(variants).toHaveLength(3);
    expect(variants.map((v) => v.key)).toEqual(firstKeys); // same S3 objects overwritten, none added
  });

  it('only one of two concurrent reprocess requests wins; reprocess while running is a 409', async () => {
    const id = await seedAccepted(photo);
    await pipeline.start(id);
    await drain();

    const results = await Promise.allSettled([pipeline.reprocess(id), pipeline.reprocess(id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(sent).toHaveLength(1);
  });

  it('a corrupt original fails conversion cleanly with a reason, and can be reprocessed later', async () => {
    const id = await seedAccepted(Buffer.from('definitely not a jpeg'));
    await pipeline.start(id);
    await drain();

    const job = await repo.find(id);
    expect(job).toMatchObject({ status: 'FAILED', failedStage: 'CONVERSION' });
    expect(job!.errorMessage).toMatch(/could not be decoded/i);
    expect(await variantsOf(id)).toHaveLength(0);

    // Fix the source (e.g. re-upload), reprocess -> completes.
    objects.set(`originals/${id}`, photo);
    await pipeline.reprocess(id);
    await drain();
    expect(await repo.find(id)).toMatchObject({
      status: 'COMPLETED',
      run: 2,
      failedStage: null,
      errorMessage: null,
    });
    expect(await variantsOf(id)).toHaveLength(3);
  });
});
