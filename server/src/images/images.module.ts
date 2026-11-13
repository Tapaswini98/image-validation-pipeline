import { Module, type Provider } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ENV, type Env } from '../config/env';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';
import { ImageRepository } from './image.repository';
import { IMAGE_QUEUE, ImageQueue } from './images.queue';
import { ImagePipelineService } from './processing/image-pipeline.service';
import { ImageProcessor } from './processing/image.processor';
import { PendingReconciler } from './processing/pending-reconciler';
import { FACE_DETECTOR, RekognitionFaceDetector, StubFaceDetector } from './processing/face-detector';

// The queue consumer only runs in the worker role (or "all" for local dev).
const runsWorker = (process.env.PROCESS_ROLE ?? 'all') !== 'api';
const workerProviders: Provider[] = runsWorker
  ? [
      ImageProcessor,
      PendingReconciler,
      ImagePipelineService,
      {
        provide: FACE_DETECTOR,
        inject: [ENV],
        useFactory: (env: Env) =>
          env.FACE_DETECTOR === 'stub' ? new StubFaceDetector() : new RekognitionFaceDetector(env),
      },
    ]
  : [];

@Module({
  imports: [
    BullModule.registerQueue({ name: IMAGE_QUEUE }),
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        storage: memoryStorage(),
        // Enforced while streaming: an oversized upload is cut off with 413 before it is fully buffered.
        limits: { fileSize: env.MAX_FILE_BYTES, files: 1, fields: 5 },
      }),
    }),
  ],
  controllers: [ImagesController],
  providers: [ImagesService, ImageRepository, ImageQueue, ...workerProviders],
  exports: [ImageQueue],
})
export class ImagesModule {}
