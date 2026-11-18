import { Inject, OnApplicationBootstrap } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { PipelineStagesService, type StageOutcome } from './pipeline-stages.service';
import { STAGE_QUEUES, type StageJobData } from './pipeline.queue';

/**
 * Thin BullMQ consumers, one per stage. Which ones a process registers depends on PROCESS_ROLE,
 * so `conversion`, `compression` and `variants` are separate deployments of the same image.
 * Concurrency per process = WORKER_CONCURRENCY; total throughput = replicas x concurrency.
 */
abstract class StageProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    protected readonly stages: PipelineStagesService,
    private readonly env: Env,
  ) {
    super();
  }

  onApplicationBootstrap() {
    this.worker.concurrency = this.env.WORKER_CONCURRENCY;
  }
}

@Processor(STAGE_QUEUES.CONVERSION)
export class ConversionProcessor extends StageProcessor {
  constructor(stages: PipelineStagesService, @Inject(ENV) env: Env) {
    super(stages, env);
  }

  process(job: Job<StageJobData>): Promise<StageOutcome> {
    return this.stages.convert(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<StageJobData> | undefined, err: Error) {
    return this.stages.onJobFailed('CONVERSION', job, err);
  }
}

@Processor(STAGE_QUEUES.COMPRESSION)
export class CompressionProcessor extends StageProcessor {
  constructor(stages: PipelineStagesService, @Inject(ENV) env: Env) {
    super(stages, env);
  }

  process(job: Job<StageJobData>): Promise<StageOutcome> {
    return this.stages.compress(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<StageJobData> | undefined, err: Error) {
    return this.stages.onJobFailed('COMPRESSION', job, err);
  }
}

@Processor(STAGE_QUEUES.VARIANTS)
export class VariantsProcessor extends StageProcessor {
  constructor(stages: PipelineStagesService, @Inject(ENV) env: Env) {
    super(stages, env);
  }

  process(job: Job<StageJobData>): Promise<StageOutcome> {
    return this.stages.generateVariants(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<StageJobData> | undefined, err: Error) {
    return this.stages.onJobFailed('VARIANTS', job, err);
  }
}
