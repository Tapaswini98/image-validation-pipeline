import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PipelineQueue } from './pipeline.queue';
import { PipelineRepository } from './pipeline.repository';
import { PipelineService } from './pipeline.service';

@Controller()
export class PipelineController {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly repo: PipelineRepository,
    private readonly queue: PipelineQueue,
  ) {}

  /** Status + variants are returned by GET /images/:id; this re-runs the pipeline. */
  @Post('images/:id/reprocess')
  @HttpCode(HttpStatus.ACCEPTED)
  async reprocess(@Param('id', ParseUUIDPipe) id: string) {
    const job = await this.pipeline.reprocess(id);
    return { imageId: job.imageId, status: job.status, run: job.run };
  }

  /** Backlog per stage + jobs per status: what you watch during a load test (and what you'd autoscale on). */
  @Get('pipeline/stats')
  @SkipThrottle()
  async stats() {
    const [queues, jobs] = await Promise.all([this.queue.depths(), this.repo.statusCounts()]);
    return { queues, jobs };
  }
}
