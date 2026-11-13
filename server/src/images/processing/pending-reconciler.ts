import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ImageRepository } from '../image.repository';
import { ImageQueue } from '../images.queue';

const SWEEP_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 2 * 60_000;

/**
 * Safety net for the gap between "row committed" and "job enqueued": if Redis was down or the
 * API crashed between the two, the image would sit in PENDING forever. Every minute we
 * re-enqueue old PENDING rows; jobId = imageId makes that a no-op when the job still exists.
 *
 * (The fully transactional alternative is an outbox table written in the same DB transaction.
 * This sweep gives the same at-least-once guarantee with less machinery.)
 */
@Injectable()
export class PendingReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PendingReconciler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repo: ImageRepository,
    private readonly queue: ImageQueue,
  ) {}

  onApplicationBootstrap() {
    void this.sweep(); // catch up immediately after a (re)start
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    try {
      const stale = await this.repo.findStalePending(new Date(Date.now() - STALE_AFTER_MS), 100);
      for (const { id } of stale) await this.queue.enqueue(id);
      if (stale.length) this.logger.warn(`re-enqueued ${stale.length} stale PENDING image(s)`);
      return stale.length;
    } catch (err) {
      this.logger.error(`reconcile sweep failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
