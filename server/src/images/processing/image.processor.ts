import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ENV, type Env } from '../../config/env';
import { ImageRepository } from '../image.repository';
import { IMAGE_QUEUE, type ImageJobData } from '../images.queue';
import { ImagePipelineService, type PipelineOutcome } from './image-pipeline.service';

/**
 * BullMQ consumer. Only registered when PROCESS_ROLE is "worker" or "all", so in production
 * the API and the CPU-heavy image work scale (and crash) independently.
 */
@Processor(IMAGE_QUEUE)
export class ImageProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ImageProcessor.name);

  constructor(
    private readonly pipeline: ImagePipelineService,
    private readonly repo: ImageRepository,
    @Inject(ENV) private readonly env: Env,
  ) {
    super();
  }

  onApplicationBootstrap() {
    this.worker.concurrency = this.env.WORKER_CONCURRENCY;
  }

  process(job: Job<ImageJobData>): Promise<PipelineOutcome> {
    return this.pipeline.process(job.data.imageId);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ImageJobData> | undefined, err: Error) {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      this.logger.error(
        `image=${job.data.imageId} FAILED after ${job.attemptsMade} attempts: ${err.message}`,
      );
      await this.repo.markFailed(job.data.imageId, err.message);
    } else {
      this.logger.warn(
        `image=${job.data.imageId} attempt ${job.attemptsMade}/${maxAttempts} failed, will retry: ${err.message}`,
      );
    }
  }
}
