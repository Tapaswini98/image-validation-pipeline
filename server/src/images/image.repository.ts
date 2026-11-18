import { Injectable } from '@nestjs/common';
import { Prisma, type Image, type ImageStatus, type RejectionCode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

const WITH_PIPELINE = { processingJob: true, variants: true } as const;
export type ImageWithPipeline = Prisma.ImageGetPayload<{ include: typeof WITH_PIPELINE }>;

export interface ProcessingMetrics {
  width?: number;
  height?: number;
  blurScore?: number;
  perceptualHash?: bigint;
  faceCount?: number;
  faceAreaRatio?: number;
  thumbnailKey?: string;
  processedKey?: string;
  processedMimeType?: string;
}

export interface SimilarityQuery {
  collectionId: string;
  excludeId: string;
  contentHash: string;
  perceptualHash: bigint;
  maxDistance: number;
}

export interface SimilarImage {
  id: string;
  originalFilename: string;
}

export interface PageQuery {
  collectionId: string;
  status?: ImageStatus;
  limit: number;
  cursor?: { createdAt: Date; id: string };
}

@Injectable()
export class ImageRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.ImageUncheckedCreateInput): Promise<Image> {
    return this.prisma.image.create({ data });
  }

  findById(id: string): Promise<ImageWithPipeline | null> {
    return this.prisma.image.findUnique({ where: { id }, include: WITH_PIPELINE });
  }

  findByIds(collectionId: string, ids: string[]): Promise<ImageWithPipeline[]> {
    return this.prisma.image.findMany({
      where: { collectionId, id: { in: ids } },
      include: WITH_PIPELINE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * Keyset (cursor) pagination instead of OFFSET: OFFSET N makes Postgres read and discard
   * N rows, so page 1000 is slow; a (created_at, id) cursor is an index seek at any depth
   * and doesn't skip/duplicate rows when new uploads arrive between page loads.
   */
  findPage({ collectionId, status, limit, cursor }: PageQuery): Promise<ImageWithPipeline[]> {
    return this.prisma.image.findMany({
      include: WITH_PIPELINE,
      where: {
        collectionId,
        ...(status && { status }),
        ...(cursor && {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  /**
   * Idempotent claim: PENDING/PROCESSING -> PROCESSING. PROCESSING is re-claimable because a
   * retried or stalled job left it there. Returns null if the image already reached a final state
   * (a duplicate job delivery is then a harmless no-op).
   */
  async claim(id: string): Promise<Image | null> {
    const { count } = await this.prisma.image.updateMany({
      where: { id, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'PROCESSING', errorMessage: null },
    });
    return count === 0 ? null : this.findById(id);
  }

  reject(
    id: string,
    code: RejectionCode,
    reason: string,
    metrics: ProcessingMetrics = {},
    db: Db = this.prisma,
  ) {
    return db.image.update({
      where: { id },
      data: {
        ...metrics,
        status: 'REJECTED',
        rejectionCode: code,
        rejectionReason: reason,
        processedAt: new Date(),
      },
    });
  }

  markFailed(id: string, errorMessage: string) {
    return this.prisma.image.updateMany({
      where: { id, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'FAILED', errorMessage: errorMessage.slice(0, 1000), processedAt: new Date() },
    });
  }

  /** FAILED -> PENDING so the job can be re-enqueued. Returns false if it wasn't FAILED. */
  async resetFailed(id: string): Promise<boolean> {
    const { count } = await this.prisma.image.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'PENDING', errorMessage: null, processedAt: null },
    });
    return count > 0;
  }

  /**
   * Exact (SHA-256) or near (dHash Hamming distance) duplicate among ACCEPTED images of the
   * same collection. Hamming distance is computed inside Postgres (XOR + popcount), so we
   * never pull every hash into Node like the old implementation did.
   *
   * Cost: linear in the collection's accepted images, which is tens per user, served by the
   * (collection_id, status, ...) index. For a global index of millions of hashes, use
   * multi-index hashing (split the 64 bits into bands) or pgvector's bit type with HNSW.
   */
  async findSimilarAccepted(q: SimilarityQuery, db: Db = this.prisma): Promise<SimilarImage | null> {
    const rows = await db.$queryRaw<SimilarImage[]>`
      SELECT id::text AS "id", original_filename AS "originalFilename"
      FROM images
      WHERE collection_id = ${q.collectionId}::uuid
        AND status = 'ACCEPTED'
        AND id <> ${q.excludeId}::uuid
        AND (
          content_hash = ${q.contentHash}
          OR bit_count((perceptual_hash # ${q.perceptualHash})::bit(64)) <= ${q.maxDistance}
        )
      ORDER BY created_at ASC
      LIMIT 1`;
    return rows[0] ?? null;
  }

  /**
   * The race-condition fix. Two near-identical photos processed concurrently by different
   * workers would BOTH pass a plain "check, then insert" (classic check-then-act race; the old
   * Promise.all bulk upload had exactly this bug). So the final check + accept runs in one
   * transaction holding a per-collection advisory lock:
   *   - only images in the SAME collection serialise; other users are unaffected
   *   - the lock is held for one indexed query + one update (milliseconds)
   *   - it is released automatically at COMMIT/ROLLBACK, even if the worker crashes
   * The partial unique index on (collection_id, content_hash) WHERE status='ACCEPTED' is a
   * second, database-level guarantee for exact duplicates.
   */
  async acceptIfUnique(
    id: string,
    q: SimilarityQuery,
    metrics: ProcessingMetrics,
  ): Promise<{ accepted: true } | { accepted: false; duplicateOf: SimilarImage }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${q.collectionId}))`;

      const duplicateOf = await this.findSimilarAccepted(q, tx);
      if (duplicateOf) {
        await this.reject(id, 'DUPLICATE', duplicateReason(duplicateOf), metrics, tx);
        return { accepted: false as const, duplicateOf };
      }

      await tx.image.update({
        where: { id },
        data: { ...metrics, status: 'ACCEPTED', processedAt: new Date() },
      });
      return { accepted: true as const };
    });
  }

  findStalePending(olderThan: Date, limit: number): Promise<Pick<Image, 'id'>[]> {
    return this.prisma.image.findMany({
      where: { status: 'PENDING', createdAt: { lt: olderThan } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  delete(id: string): Promise<Image> {
    return this.prisma.image.delete({ where: { id } });
  }
}

export function duplicateReason(dup: SimilarImage): string {
  return `Too similar to "${dup.originalFilename}", which you already uploaded. Use photos with different poses, outfits or backgrounds.`;
}
