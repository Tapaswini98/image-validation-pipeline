import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PipelineStatus, ProcessingJob } from '@prisma/client';
import { PipelineQueue } from './pipeline.queue';
import { PipelineRepository } from './pipeline.repository';

const FIRST_STAGE_STATUS: PipelineStatus = 'QUEUED';

@Injectable()
export class PipelineService {
  constructor(
    private readonly repo: PipelineRepository,
    private readonly queue: PipelineQueue,
  ) {}

  /** Called when validation accepts an image. Safe to call repeatedly. */
  async start(imageId: string): Promise<ProcessingJob> {
    const job = await this.repo.ensure(imageId);
    if (job.status === FIRST_STAGE_STATUS) {
      await this.queue.enqueue('CONVERSION', { imageId, run: job.run });
    }
    return job;
  }

  /**
   * Re-run the whole pipeline (after a failure, or to regenerate variants). Only from a terminal
   * state: reprocessing while a run is in flight is a 409, not a second concurrent run.
   */
  async reprocess(imageId: string): Promise<ProcessingJob> {
    const source = await this.repo.findSource(imageId);
    if (!source) throw new NotFoundException(`Image ${imageId} not found`);
    if (source.status !== 'ACCEPTED') {
      throw new ConflictException('Only images that passed validation can be processed.');
    }

    const reset = await this.repo.resetForReprocess(imageId);
    if (reset) {
      await this.queue.enqueue('CONVERSION', { imageId, run: reset.run });
      return reset;
    }

    const existing = await this.repo.find(imageId);
    if (!existing) return this.start(imageId);
    throw new ConflictException(`Pipeline is already running for this image (status ${existing.status}).`);
  }
}
