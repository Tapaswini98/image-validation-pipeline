import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ENV, type Env } from '../config/env';

export const IMAGE_QUEUE = 'image-processing';

export interface ImageJobData {
  imageId: string;
}

@Injectable()
export class ImageQueue {
  constructor(
    @InjectQueue(IMAGE_QUEUE) private readonly queue: Queue<ImageJobData>,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * jobId = imageId makes enqueueing idempotent: adding the same image twice while a job
   * for it exists is a no-op, so the reconciler can safely re-enqueue.
   */
  async enqueue(imageId: string): Promise<void> {
    await this.queue.add(
      'process',
      { imageId },
      {
        jobId: imageId,
        attempts: this.env.JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    );
  }

  /** A failed job is kept in Redis (for inspection), and would make enqueue() a no-op: remove it first. */
  async requeue(imageId: string): Promise<void> {
    await this.queue.remove(imageId);
    await this.enqueue(imageId);
  }

  /** Round-trips to Redis and reports backlog: useful for health checks and autoscaling workers. */
  depth(): Promise<Record<string, number>> {
    return this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
  }
}
