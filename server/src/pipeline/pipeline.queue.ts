import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { PipelineStage } from '@prisma/client';
import type { Queue } from 'bullmq';
import { ENV, type Env } from '../config/env';

/** One queue per stage: each stage's backlog is visible on its own and each scales on its own. */
export const STAGE_QUEUES = {
  CONVERSION: 'pipeline-conversion',
  COMPRESSION: 'pipeline-compression',
  VARIANTS: 'pipeline-variants',
} as const satisfies Record<PipelineStage, string>;

export interface StageJobData {
  imageId: string;
  /** Which pipeline run this message belongs to; messages from an older run are skipped. */
  run: number;
}

@Injectable()
export class PipelineQueue {
  private readonly queues: Record<PipelineStage, Queue<StageJobData>>;

  constructor(
    @InjectQueue(STAGE_QUEUES.CONVERSION) conversion: Queue<StageJobData>,
    @InjectQueue(STAGE_QUEUES.COMPRESSION) compression: Queue<StageJobData>,
    @InjectQueue(STAGE_QUEUES.VARIANTS) variants: Queue<StageJobData>,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.queues = { CONVERSION: conversion, COMPRESSION: compression, VARIANTS: variants };
  }

  /**
   * jobId = imageId + run: enqueuing the same stage twice for the same run (reconciler, retry
   * after a crash) is a no-op while the job exists. Correctness doesn't depend on it though:
   * every stage re-checks the DB state before doing work.
   */
  async enqueue(stage: PipelineStage, data: StageJobData): Promise<void> {
    await this.queues[stage].add(stage.toLowerCase(), data, {
      jobId: `${data.imageId}-r${data.run}`,
      attempts: this.env.JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { count: 5_000 },
      removeOnFail: { count: 5_000 },
    });
  }

  async depths(): Promise<Record<PipelineStage, Record<string, number>>> {
    const entries = await Promise.all(
      (Object.keys(this.queues) as PipelineStage[]).map(
        async (stage) =>
          [stage, await this.queues[stage].getJobCounts('waiting', 'active', 'delayed', 'failed')] as const,
      ),
    );
    return Object.fromEntries(entries) as Record<PipelineStage, Record<string, number>>;
  }
}
