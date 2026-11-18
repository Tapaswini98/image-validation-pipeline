import { Module, type Provider } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { runsRole } from '../config/roles';
import { PipelineController } from './pipeline.controller';
import { PipelineStagesService } from './pipeline-stages.service';
import { PipelineQueue, STAGE_QUEUES } from './pipeline.queue';
import { PipelineReconciler } from './pipeline-reconciler';
import { PipelineRepository } from './pipeline.repository';
import { PipelineService } from './pipeline.service';
import { CompressionProcessor, ConversionProcessor, VariantsProcessor } from './pipeline.processors';

// Each stage's consumer is registered only in its own role (or "all" for local dev).
const consumers: Provider[] = [
  ...(runsRole('conversion') ? [ConversionProcessor, PipelineReconciler] : []),
  ...(runsRole('compression') ? [CompressionProcessor] : []),
  ...(runsRole('variants') ? [VariantsProcessor] : []),
];

@Module({
  imports: [Object.values(STAGE_QUEUES).map((name) => BullModule.registerQueue({ name }))].flat(),
  controllers: [PipelineController],
  providers: [PipelineRepository, PipelineQueue, PipelineService, PipelineStagesService, ...consumers],
  exports: [PipelineService, PipelineQueue],
})
export class PipelineModule {}
