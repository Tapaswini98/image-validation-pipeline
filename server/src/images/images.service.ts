import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Image, RejectionCode } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { StorageService } from '../storage/storage.service';
import type { ImageDto, ImagePage, ListImagesQuery } from './dto/images.dto';
import { ImageRepository } from './image.repository';
import { ImageQueue } from './images.queue';
import { originalKey } from './storage-keys';
import { detectImageType } from './validation/file-signature';

/**
 * API side of the pipeline. The request path does only cheap, synchronous work
 * (size check, magic bytes, hash, one S3 put, one INSERT, one enqueue) and returns 202.
 * Everything CPU- or network-heavy happens in the worker.
 */
@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    private readonly repo: ImageRepository,
    private readonly storage: StorageService,
    private readonly queue: ImageQueue,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async ingest(file: Express.Multer.File | undefined, collectionId: string): Promise<ImageDto> {
    if (!file)
      throw new BadRequestException('Send the image as multipart/form-data in a field named "file".');

    const base = {
      collectionId,
      originalFilename: sanitizeFilename(file.originalname),
      sizeBytes: file.size,
    };

    // Synchronous rejections: recorded (so they show up under "Rejected") but never stored or queued.
    if (file.size < this.env.MIN_FILE_BYTES) {
      return this.rejectAtIntake(
        base,
        'FILE_TOO_SMALL',
        `File is too small (${Math.round(file.size / 1024)} KB). Minimum is ${Math.round(this.env.MIN_FILE_BYTES / 1024)} KB.`,
      );
    }
    const mime = detectImageType(file.buffer);
    if (!mime) {
      return this.rejectAtIntake(
        base,
        'UNSUPPORTED_FORMAT',
        'Unsupported file type. Only JPEG, PNG and HEIC images are accepted.',
      );
    }

    const id = randomUUID();
    const key = originalKey(id);
    try {
      await this.storage.put(key, file.buffer, mime);
    } catch (err) {
      this.logger.error(`S3 put failed for new upload: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Storage is temporarily unavailable. Please retry.');
    }

    const image = await this.repo.create({
      ...base,
      id,
      detectedMimeType: mime,
      originalKey: key,
      contentHash: createHash('sha256').update(file.buffer).digest('hex'),
      status: 'PENDING',
    });

    // If this fails the row stays PENDING and the reconciler re-enqueues it: the client
    // still gets 202 because the upload itself is durably stored.
    // Bounded wait: while Redis is unreachable, ioredis buffers commands instead of failing,
    // which would otherwise hang the upload request indefinitely.
    await withTimeout(this.queue.enqueue(id), ENQUEUE_TIMEOUT_MS).catch((err: Error) =>
      this.logger.error(`enqueue failed for image=${id}, reconciler will retry: ${err.message}`),
    );

    return this.toDto(image);
  }

  async list(q: ListImagesQuery): Promise<ImagePage> {
    if (q.ids?.length) {
      const images = await this.repo.findByIds(q.collectionId, q.ids);
      return { items: await Promise.all(images.map((i) => this.toDto(i))), nextCursor: null };
    }

    const images = await this.repo.findPage({
      collectionId: q.collectionId,
      status: q.status,
      limit: q.limit + 1, // fetch one extra to know if there is a next page
      cursor: q.cursor ? decodeCursor(q.cursor) : undefined,
    });
    const page = images.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: await Promise.all(page.map((i) => this.toDto(i))),
      nextCursor: images.length > q.limit && last ? encodeCursor(last) : null,
    };
  }

  async get(id: string): Promise<ImageDto> {
    return this.toDto(await this.mustFind(id));
  }

  async retry(id: string): Promise<ImageDto> {
    if (!(await this.repo.resetFailed(id))) {
      await this.mustFind(id);
      throw new ConflictException('Only images in FAILED status can be retried.');
    }
    await this.queue.requeue(id);
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const image = await this.mustFind(id);
    await this.repo.delete(id);
    // Delete the row first: if S3 cleanup fails we leak storage (cheap, sweepable),
    // never a row pointing at missing objects.
    await this.storage
      .deleteMany([image.originalKey, image.processedKey, image.thumbnailKey])
      .catch((err: Error) => this.logger.warn(`S3 cleanup failed for image=${id}: ${err.message}`));
  }

  private async mustFind(id: string): Promise<Image> {
    const image = await this.repo.findById(id);
    if (!image) throw new NotFoundException(`Image ${id} not found`);
    return image;
  }

  private async rejectAtIntake(
    base: { collectionId: string; originalFilename: string; sizeBytes: number },
    code: RejectionCode,
    reason: string,
  ): Promise<ImageDto> {
    const image = await this.repo.create({
      ...base,
      status: 'REJECTED',
      rejectionCode: code,
      rejectionReason: reason,
      processedAt: new Date(),
    });
    return this.toDto(image);
  }

  private async toDto(i: Image): Promise<ImageDto> {
    const [url, thumbnailUrl] = await Promise.all([
      i.status === 'ACCEPTED' && i.processedKey ? this.storage.presignGet(i.processedKey) : null,
      i.thumbnailKey ? this.storage.presignGet(i.thumbnailKey) : null,
    ]);
    return {
      id: i.id,
      collectionId: i.collectionId,
      filename: i.originalFilename,
      status: i.status,
      rejectionCode: i.rejectionCode,
      rejectionReason:
        i.status === 'FAILED'
          ? 'Processing failed due to a temporary error. You can retry.'
          : i.rejectionReason,
      mimeType: i.processedMimeType ?? i.detectedMimeType,
      sizeBytes: i.sizeBytes,
      width: i.width,
      height: i.height,
      metrics: { blurScore: i.blurScore, faceCount: i.faceCount, faceAreaRatio: i.faceAreaRatio },
      url,
      thumbnailUrl,
      createdAt: i.createdAt.toISOString(),
      processedAt: i.processedAt?.toISOString() ?? null,
    };
  }
}

const ENQUEUE_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Strip path components and control characters; the name is only ever displayed, never used as a key. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = [...base]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
  return (clean || 'unnamed').slice(0, 255);
}

function encodeCursor(i: Pick<Image, 'createdAt' | 'id'>): string {
  return Buffer.from(`${i.createdAt.toISOString()}|${i.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = new Date(iso);
  if (!id || Number.isNaN(createdAt.getTime())) throw new BadRequestException('Invalid cursor');
  return { createdAt, id };
}
