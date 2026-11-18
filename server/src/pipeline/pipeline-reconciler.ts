import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { PipelineStage, PipelineStatus } from '@prisma/client';
import { PipelineQueue } from './pipeline.queue';
import { PipelineRepository } from './pipeline.repository';
import { PipelineService } from './pipeline.service';

const SWEEP_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 2 * 60_000;

const STAGE_FOR_STATUS: Partial<Record<PipelineStatus, PipelineStage>> = {
  QUEUED: 'CONVERSION',
  CONVERTING: 'CONVERSION',
  COMPRESSING: 'COMPRESSION',
  GENERATING_VARIANTS: 'VARIANTS',
};

/**
 * Safety net for the gaps between "DB updated" and "message enqueued" (Redis down, process
 * killed in between). Every minute: start the pipeline for accepted images that have no job,
 * and re-enqueue the current stage for jobs that haven't moved in 2 minutes. Both are no-ops
 * when the message already exists (jobId) or the stage already ran (DB guard).
 * Same at-least-once idea as Part 1's PendingReconciler; an outbox table is the heavier alternative.
 */
@Injectable()
export class PipelineReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PipelineReconciler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repo: PipelineRepository,
    private readonly queue: PipelineQueue,
    private readonly pipeline: PipelineService,
  ) {}

  onApplicationBootstrap() {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    try {
      const olderThan = new Date(Date.now() - STALE_AFTER_MS);
      const missing = await this.repo.findAcceptedWithoutJob(olderThan, 100);
      for (const { id } of missing) await this.pipeline.start(id);

      const stuck = await this.repo.findStuck(olderThan, 100);
      for (const job of stuck) {
        const stage = STAGE_FOR_STATUS[job.status];
        if (stage) await this.queue.enqueue(stage, { imageId: job.imageId, run: job.run });
      }
      if (missing.length || stuck.length) {
        this.logger.warn(`reconciled: started ${missing.length}, re-enqueued ${stuck.length}`);
      }
    } catch (err) {
      this.logger.error(`pipeline reconcile sweep failed: ${(err as Error).message}`);
    }
  }
}
