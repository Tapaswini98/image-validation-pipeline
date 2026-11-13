import type { Image } from '@prisma/client';
import { loadEnv } from '../../config/env';
import type { ImageRepository } from '../image.repository';
import type { StorageService } from '../../storage/storage.service';
import type { DetectedFace } from '../validation/face-rules';
import { ImagePipelineService } from './image-pipeline.service';
import { blurred, sceneJpeg } from '../../test-utils/images';

/**
 * Pipeline tests: REAL decoding/blur/hash on generated images; only the boundaries
 * (DB, S3, Rekognition) are faked, so the tests exercise the actual validation logic.
 */
const env = loadEnv({
  DATABASE_URL: 'postgresql://x@localhost/x',
  S3_BUCKET: 'test',
  S3_REGION: 'us-east-1',
});
const oneFace: DetectedFace[] = [{ confidence: 99.9, box: { left: 0.3, top: 0.2, width: 0.4, height: 0.4 } }];

function setup(opts: {
  file: Buffer;
  faces?: DetectedFace[];
  earlyDuplicate?: boolean;
  raceDuplicate?: boolean;
  claimed?: boolean;
}) {
  const record = {
    id: '11111111-1111-4111-8111-111111111111',
    collectionId: '22222222-2222-4222-8222-222222222222',
    originalKey: 'originals/1',
    detectedMimeType: 'image/jpeg',
    contentHash: 'a'.repeat(64),
  } as Image;
  const dup = { id: '33333333-3333-4333-8333-333333333333', originalFilename: 'first.jpg' };

  const repo = {
    claim: jest.fn().mockResolvedValue(opts.claimed === false ? null : record),
    reject: jest.fn().mockResolvedValue(undefined),
    findSimilarAccepted: jest.fn().mockResolvedValue(opts.earlyDuplicate ? dup : null),
    acceptIfUnique: jest
      .fn()
      .mockResolvedValue(opts.raceDuplicate ? { accepted: false, duplicateOf: dup } : { accepted: true }),
  };
  const storage = {
    get: jest.fn().mockResolvedValue(opts.file),
    put: jest.fn().mockResolvedValue(undefined),
    deleteMany: jest.fn().mockResolvedValue(undefined),
  };
  const detector = { detect: jest.fn().mockResolvedValue(opts.faces ?? oneFace) };
  const pipeline = new ImagePipelineService(
    repo as unknown as ImageRepository,
    storage as unknown as StorageService,
    detector,
    env,
  );
  return { pipeline, repo, storage, detector, record };
}

describe('ImagePipelineService', () => {
  let goodPhoto: Buffer;
  beforeAll(async () => {
    goodPhoto = await sceneJpeg(1200, 1200);
  });

  it('accepts a sharp, large, single-face, unique photo and stores processed + thumbnail', async () => {
    const { pipeline, repo, storage } = setup({ file: goodPhoto });
    await expect(pipeline.process('id')).resolves.toBe('ACCEPTED');

    const keys = storage.put.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(
      expect.arrayContaining([expect.stringMatching(/^thumbnails\//), expect.stringMatching(/^processed\//)]),
    );
    expect(repo.acceptIfUnique).toHaveBeenCalledWith(
      'id',
      expect.objectContaining({ maxDistance: env.SIMILARITY_MAX_HAMMING }),
      expect.objectContaining({ width: 1200, height: 1200, faceCount: 1 }),
    );
  });

  it('rejects low resolution before calling the face detector', async () => {
    const { pipeline, repo, detector } = setup({ file: await sceneJpeg(400, 300) });
    await expect(pipeline.process('id')).resolves.toBe('REJECTED');
    expect(repo.reject).toHaveBeenCalledWith(
      'id',
      'RESOLUTION_TOO_LOW',
      expect.stringContaining('400×300'),
      expect.any(Object),
    );
    expect(detector.detect).not.toHaveBeenCalled();
  });

  it('rejects a blurry photo', async () => {
    const { pipeline, repo, detector } = setup({ file: await blurred(goodPhoto) });
    await expect(pipeline.process('id')).resolves.toBe('REJECTED');
    expect(repo.reject).toHaveBeenCalledWith(
      'id',
      'BLURRY',
      expect.any(String),
      expect.objectContaining({ blurScore: expect.any(Number) }),
    );
    expect(detector.detect).not.toHaveBeenCalled();
  });

  it('rejects an obvious duplicate before paying for face detection', async () => {
    const { pipeline, repo, detector } = setup({ file: goodPhoto, earlyDuplicate: true });
    await expect(pipeline.process('id')).resolves.toBe('REJECTED');
    expect(repo.reject).toHaveBeenCalledWith(
      'id',
      'DUPLICATE',
      expect.stringContaining('first.jpg'),
      expect.any(Object),
    );
    expect(detector.detect).not.toHaveBeenCalled();
  });

  it.each([
    ['no face', [], 'NO_FACE'],
    ['two faces', [...oneFace, ...oneFace], 'MULTIPLE_FACES'],
    ['small face', [{ confidence: 99, box: { left: 0, top: 0, width: 0.1, height: 0.1 } }], 'FACE_TOO_SMALL'],
  ])('rejects %s', async (_label, faces, code) => {
    const { pipeline, repo, storage } = setup({ file: goodPhoto, faces });
    await expect(pipeline.process('id')).resolves.toBe('REJECTED');
    expect(repo.reject).toHaveBeenCalledWith('id', code, expect.any(String), expect.any(Object));
    expect(storage.put.mock.calls.map((c) => c[0])).not.toContainEqual(expect.stringMatching(/^processed\//));
  });

  it('cleans up the processed object when it loses the duplicate race at the final locked check', async () => {
    const { pipeline, storage } = setup({ file: goodPhoto, raceDuplicate: true });
    await expect(pipeline.process('id')).resolves.toBe('REJECTED');
    expect(storage.deleteMany).toHaveBeenCalledWith([expect.stringMatching(/^processed\//)]);
  });

  it('marks undecodable files as CORRUPT_IMAGE (terminal, not retried)', async () => {
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000, 1)]);
    const { pipeline, repo } = setup({ file: corrupt });
    await expect(pipeline.process('id')).resolves.toBe('REJECTED');
    expect(repo.reject).toHaveBeenCalledWith('id', 'CORRUPT_IMAGE', expect.any(String), {});
  });

  it('propagates face-detector outages so the queue retries (never a false rejection)', async () => {
    const { pipeline, repo, detector } = setup({ file: goodPhoto });
    detector.detect.mockRejectedValue(new Error('ThrottlingException'));
    await expect(pipeline.process('id')).rejects.toThrow('ThrottlingException');
    expect(repo.reject).not.toHaveBeenCalled();
  });

  it('is a no-op for an image that was already finalised (duplicate job delivery)', async () => {
    const { pipeline, storage } = setup({ file: goodPhoto, claimed: false });
    await expect(pipeline.process('id')).resolves.toBe('SKIPPED');
    expect(storage.get).not.toHaveBeenCalled();
  });
});
