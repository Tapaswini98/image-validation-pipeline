import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PipelineStage } from '@prisma/client';
import type { Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { StorageService } from '../storage/storage.service';
import { compressJpeg, convertToJpeg, resizeJpeg, UnprocessableImageError, type EncodedImage } from './media';
import { compressedKey, convertedKey, variantKey } from './pipeline-keys';
import { PipelineQueue, type StageJobData } from './pipeline.queue';
import { PipelineRepository, type VariantRecord } from './pipeline.repository';

export type StageOutcome = 'DONE' | 'SKIPPED' | 'FAILED';

const JPEG = 'image/jpeg';

/**
 * The three stages. Each one is stateless: input from S3, output to S3, state in Postgres,
 * hand-off through the next stage's queue. Any instance of a stage can pick up any job.
 *
 * Shape of every stage:
 *   1. guard   - is the job in the state this stage expects, for this run? if not: SKIPPED
 *   2. work    - read input, transform, write output under a deterministic key (overwrite = idempotent)
 *   3. advance - conditional UPDATE to the next status; only the winner enqueues the next stage
 *
 * Errors: an unprocessable input is recorded as FAILED and the job ends cleanly (no retries).
 * Anything else (S3, DB) is thrown so BullMQ retries with backoff; after the last attempt
 * onJobFailed() records FAILED with the stage and reason.
 */
@Injectable()
export class PipelineStagesService {
  private readonly logger = new Logger(PipelineStagesService.name);

  constructor(
    private readonly repo: PipelineRepository,
    private readonly storage: StorageService,
    private readonly queue: PipelineQueue,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async convert({ imageId, run }: StageJobData): Promise<StageOutcome> {
    // CONVERTING is accepted too: a retry or a redelivered stalled job re-enters the stage.
    const claimed = await this.repo.transition(imageId, run, ['QUEUED', 'CONVERTING'], {
      status: 'CONVERTING',
    });
    if (!claimed) return this.skip('CONVERSION', imageId, run);

    const source = await this.repo.findSource(imageId);
    if (!source?.originalKey || !source.detectedMimeType) {
      return this.fail('CONVERSION', imageId, run, 'Original upload is missing');
    }

    let converted: EncodedImage;
    try {
      const original = await this.storage.get(source.originalKey);
      converted = await convertToJpeg(original, source.detectedMimeType);
    } catch (err) {
      if (err instanceof UnprocessableImageError) {
        return this.fail('CONVERSION', imageId, run, err.message);
      }
      if ((err as Error).name === 'NoSuchKey') {
        return this.fail('CONVERSION', imageId, run, 'Original upload is missing from storage');
      }
      throw err;
    }

    const key = convertedKey(imageId);
    await this.storage.put(key, converted.data, JPEG);

    const advanced = await this.repo.transition(imageId, run, ['CONVERTING'], {
      status: 'COMPRESSING',
      convertedKey: key,
      convertedBytes: converted.data.length,
      width: converted.width,
      height: converted.height,
      convertedAt: new Date(),
    });
    if (!advanced) return this.skip('CONVERSION', imageId, run);

    await this.queue.enqueue('COMPRESSION', { imageId, run });
    this.logger.log(`image=${imageId} run=${run} converted ${converted.width}x${converted.height}`);
    return 'DONE';
  }

  async compress({ imageId, run }: StageJobData): Promise<StageOutcome> {
    const job = await this.repo.find(imageId);
    if (!job || job.run !== run || job.status !== 'COMPRESSING' || !job.convertedKey) {
      return this.skip('COMPRESSION', imageId, run);
    }

    const master = await this.storage.get(job.convertedKey);
    const compressed = await compressJpeg(master, this.env.COMPRESSION_QUALITY);
    const key = compressedKey(imageId);
    await this.storage.put(key, compressed.data, JPEG);

    const ratio = master.length / compressed.data.length;
    const advanced = await this.repo.transition(imageId, run, ['COMPRESSING'], {
      status: 'GENERATING_VARIANTS',
      compressedKey: key,
      compressedBytes: compressed.data.length,
      compressionRatio: Math.round(ratio * 100) / 100,
      compressedAt: new Date(),
    });
    if (!advanced) return this.skip('COMPRESSION', imageId, run);

    await this.queue.enqueue('VARIANTS', { imageId, run });
    this.logger.log(
      `image=${imageId} run=${run} compressed ${master.length} -> ${compressed.data.length} bytes (${ratio.toFixed(2)}x)`,
    );
    return 'DONE';
  }

  async generateVariants({ imageId, run }: StageJobData): Promise<StageOutcome> {
    const job = await this.repo.find(imageId);
    if (
      !job ||
      job.run !== run ||
      job.status !== 'GENERATING_VARIANTS' ||
      !job.convertedKey ||
      !job.compressedKey
    ) {
      return this.skip('VARIANTS', imageId, run);
    }

    const [master, compressed] = await Promise.all([
      this.storage.get(job.convertedKey),
      this.storage.get(job.compressedKey),
    ]);
    const quality = this.env.COMPRESSION_QUALITY;
    const [thumbnail, web] = await Promise.all([
      resizeJpeg(master, this.env.THUMBNAIL_MAX_PX, Math.min(quality, 75)),
      resizeJpeg(master, this.env.WEB_MAX_PX, quality),
    ]);
    // Full size = the compression stage's output (already full resolution and compressed).
    const full = { data: compressed, width: job.width ?? 0, height: job.height ?? 0 };

    const outputs = { THUMBNAIL: thumbnail, WEB: web, FULL: full } as const;
    const variants: VariantRecord[] = await Promise.all(
      (Object.keys(outputs) as (keyof typeof outputs)[]).map(async (kind) => {
        const out = outputs[kind];
        const key = variantKey(imageId, kind);
        await this.storage.put(key, out.data, JPEG);
        return {
          kind,
          key,
          url: this.storage.objectUrl(key),
          mimeType: JPEG,
          width: out.width,
          height: out.height,
          sizeBytes: out.data.length,
        };
      }),
    );

    const completed = await this.repo.complete(imageId, run, variants);
    if (!completed) return this.skip('VARIANTS', imageId, run);
    this.logger.log(`image=${imageId} run=${run} COMPLETED (${variants.length} variants)`);
    return 'DONE';
  }

  /** Called by the processors when BullMQ reports a failed attempt. */
  async onJobFailed(stage: PipelineStage, job: Job<StageJobData> | undefined, err: Error) {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    const { imageId, run } = job.data;
    if (job.attemptsMade >= maxAttempts) {
      this.logger.error(
        `image=${imageId} run=${run} ${stage} failed after ${job.attemptsMade} attempts: ${err.message}`,
      );
      await this.repo.markFailed(imageId, run, stage, `${err.message} (after ${job.attemptsMade} attempts)`);
    } else {
      this.logger.warn(
        `image=${imageId} run=${run} ${stage} attempt ${job.attemptsMade}/${maxAttempts} failed, retrying: ${err.message}`,
      );
    }
  }

  private async fail(
    stage: PipelineStage,
    imageId: string,
    run: number,
    reason: string,
  ): Promise<StageOutcome> {
    await this.repo.markFailed(imageId, run, stage, reason);
    this.logger.warn(`image=${imageId} run=${run} ${stage} FAILED: ${reason}`);
    return 'FAILED';
  }

  private skip(stage: PipelineStage, imageId: string, run: number): StageOutcome {
    this.logger.log(
      `image=${imageId} run=${run} ${stage} skipped (stale run, duplicate delivery or already done)`,
    );
    return 'SKIPPED';
  }
}
