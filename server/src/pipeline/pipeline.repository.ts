import { Injectable } from '@nestjs/common';
import type { PipelineStage, PipelineStatus, Prisma, ProcessingJob, VariantKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const IN_FLIGHT: PipelineStatus[] = ['QUEUED', 'CONVERTING', 'COMPRESSING', 'GENERATING_VARIANTS'];

export interface VariantRecord {
  kind: VariantKind;
  key: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Every state change is a conditional UPDATE ... WHERE image_id = ? AND run = ? AND status IN (...).
 * That one rule gives us idempotency: a duplicate or stale queue message finds the row in an
 * unexpected state, updates 0 rows, and the caller skips. No locks, no read-then-write races.
 */
@Injectable()
export class PipelineRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(imageId: string): Promise<ProcessingJob | null> {
    return this.prisma.processingJob.findUnique({ where: { imageId } });
  }

  findSource(imageId: string) {
    return this.prisma.image.findUnique({
      where: { id: imageId },
      select: { originalKey: true, detectedMimeType: true, status: true },
    });
  }

  /** Creates the job if it doesn't exist; never touches an existing one. */
  ensure(imageId: string): Promise<ProcessingJob> {
    return this.prisma.processingJob.upsert({ where: { imageId }, create: { imageId }, update: {} });
  }

  async transition(
    imageId: string,
    run: number,
    from: PipelineStatus[],
    data: Prisma.ProcessingJobUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await this.prisma.processingJob.updateMany({
      where: { imageId, run, status: { in: from } },
      data,
    });
    return count > 0;
  }

  markFailed(imageId: string, run: number, stage: PipelineStage, message: string): Promise<boolean> {
    return this.transition(imageId, run, IN_FLIGHT, {
      status: 'FAILED',
      failedStage: stage,
      errorMessage: message.slice(0, 1000),
      failedAt: new Date(),
    });
  }

  /** Variants + COMPLETED in one transaction: a job is never COMPLETED with missing variants. */
  async complete(imageId: string, run: number, variants: VariantRecord[]): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.processingJob.updateMany({
        where: { imageId, run, status: 'GENERATING_VARIANTS' },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      if (count === 0) return false;
      for (const v of variants) {
        // Composite PK (image_id, kind): reprocessing replaces rows, never adds duplicates.
        await tx.imageVariant.upsert({
          where: { imageId_kind: { imageId, kind: v.kind } },
          create: { imageId, ...v },
          update: v,
        });
      }
      return true;
    });
  }

  /** COMPLETED/FAILED -> QUEUED with run + 1. Atomic, so two concurrent reprocess calls can't both win. */
  async resetForReprocess(imageId: string): Promise<ProcessingJob | null> {
    const { count } = await this.prisma.processingJob.updateMany({
      where: { imageId, status: { in: ['COMPLETED', 'FAILED'] } },
      data: {
        status: 'QUEUED',
        run: { increment: 1 },
        failedStage: null,
        errorMessage: null,
        failedAt: null,
        convertedAt: null,
        compressedAt: null,
        completedAt: null,
        queuedAt: new Date(),
      },
    });
    return count > 0 ? this.find(imageId) : null;
  }

  findStuck(olderThan: Date, limit: number): Promise<ProcessingJob[]> {
    return this.prisma.processingJob.findMany({
      where: { status: { in: IN_FLIGHT }, updatedAt: { lt: olderThan } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  }

  /** Accepted by validation but the pipeline never started (crash between accept and enqueue). */
  findAcceptedWithoutJob(olderThan: Date, limit: number): Promise<{ id: string }[]> {
    return this.prisma.image.findMany({
      where: { status: 'ACCEPTED', processingJob: { is: null }, processedAt: { lt: olderThan } },
      select: { id: true },
      take: limit,
    });
  }

  async statusCounts(): Promise<Record<string, number>> {
    const rows = await this.prisma.processingJob.groupBy({ by: ['status'], _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  }
}
