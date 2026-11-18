import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RejectionCode } from '@prisma/client';
import { ENV, type Env } from '../../config/env';
import { StorageService } from '../../storage/storage.service';
import {
  ImageRepository,
  type ProcessingMetrics,
  type SimilarityQuery,
  duplicateReason,
} from '../image.repository';
import { evaluateFaces } from '../validation/face-rules';
import type { SupportedMimeType } from '../validation/file-signature';
import { CorruptImageError, decodeImage, type DecodedImage } from './image-decoder';
import { FACE_DETECTOR, type FaceDetector } from './face-detector';
import { processedKey, thumbnailKey } from '../storage-keys';
import { PipelineService } from '../../pipeline/pipeline.service';

export type PipelineOutcome = 'ACCEPTED' | 'REJECTED' | 'SKIPPED';

/**
 * Runs inside the background worker. Order is deliberate: cheapest checks first,
 * the paid external call (face detection) as late as possible, and the DB lock only
 * around the final duplicate check + accept.
 *
 *   decode/convert -> resolution -> blur -> duplicate pre-check -> faces -> store -> locked dup check + accept
 *
 * Validation failures are business outcomes (REJECTED, job completes). Infrastructure
 * errors (S3, Rekognition, DB) are thrown so BullMQ retries with backoff; after the last
 * attempt the image is marked FAILED and can be retried by the user.
 */
@Injectable()
export class ImagePipelineService {
  private readonly logger = new Logger(ImagePipelineService.name);

  constructor(
    private readonly repo: ImageRepository,
    private readonly storage: StorageService,
    @Inject(FACE_DETECTOR) private readonly faceDetector: FaceDetector,
    @Inject(ENV) private readonly env: Env,
    private readonly mediaPipeline: PipelineService,
  ) {}

  async process(imageId: string): Promise<PipelineOutcome> {
    const image = await this.repo.claim(imageId);
    if (!image) {
      this.logger.log(`image=${imageId} already finalised, skipping duplicate job delivery`);
      return 'SKIPPED';
    }
    if (!image.originalKey || !image.detectedMimeType || !image.contentHash) {
      throw new Error(`image=${imageId} is missing its stored original`);
    }

    const original = await this.storage.get(image.originalKey);

    let decoded: DecodedImage;
    try {
      decoded = await decodeImage(original, image.detectedMimeType as SupportedMimeType);
    } catch (err) {
      if (err instanceof CorruptImageError) {
        this.logger.warn(`image=${imageId} ${err.message}`);
        return this.reject(
          imageId,
          'CORRUPT_IMAGE',
          'This file could not be read as an image. It may be corrupted.',
        );
      }
      throw err;
    }

    // Thumbnail first so even rejected images can be previewed in the UI.
    const thumbKey = thumbnailKey(imageId);
    await this.storage.put(thumbKey, decoded.thumbnail, 'image/jpeg');

    const metrics: ProcessingMetrics = {
      thumbnailKey: thumbKey,
      width: decoded.width,
      height: decoded.height,
      blurScore: decoded.blurScore,
      perceptualHash: decoded.perceptualHash,
      processedMimeType: decoded.processedMimeType,
    };

    // 1. Resolution
    const shortestSide = Math.min(decoded.width, decoded.height);
    if (shortestSide < this.env.MIN_DIMENSION_PX) {
      return this.reject(
        imageId,
        'RESOLUTION_TOO_LOW',
        `Resolution too low (${decoded.width}×${decoded.height}). The shortest side must be at least ${this.env.MIN_DIMENSION_PX}px.`,
        metrics,
      );
    }

    // 2. Blur
    if (decoded.blurScore < this.env.BLUR_THRESHOLD) {
      return this.reject(
        imageId,
        'BLURRY',
        `Photo is too blurry (sharpness ${decoded.blurScore.toFixed(0)}, minimum ${this.env.BLUR_THRESHOLD}). Use a photo that is in focus.`,
        metrics,
      );
    }

    // 3. Duplicate pre-check (no lock): rejects obvious duplicates before paying for face detection.
    const similarity: SimilarityQuery = {
      collectionId: image.collectionId,
      excludeId: imageId,
      contentHash: image.contentHash,
      perceptualHash: decoded.perceptualHash,
      maxDistance: this.env.SIMILARITY_MAX_HAMMING,
    };
    const earlyDuplicate = await this.repo.findSimilarAccepted(similarity);
    if (earlyDuplicate) return this.reject(imageId, 'DUPLICATE', duplicateReason(earlyDuplicate), metrics);

    // 4. Faces (external call: errors propagate -> retry)
    const faces = await this.faceDetector.detect(decoded.faceDetectionInput);
    const verdict = evaluateFaces(faces, decoded, {
      minConfidence: this.env.MIN_FACE_CONFIDENCE,
      minAreaRatio: this.env.MIN_FACE_AREA_RATIO,
      minSizePx: this.env.MIN_FACE_SIZE_PX,
    });
    metrics.faceCount = verdict.faceCount;
    metrics.faceAreaRatio = verdict.faceAreaRatio;
    if (!verdict.ok) return this.reject(imageId, verdict.code, verdict.reason, metrics);

    // 5. Store the normalised image, then do the authoritative duplicate check + accept atomically.
    const procKey = processedKey(imageId, decoded.processedMimeType);
    await this.storage.put(procKey, decoded.processed, decoded.processedMimeType);
    metrics.processedKey = procKey;

    const result = await this.repo.acceptIfUnique(imageId, similarity, metrics);
    if (!result.accepted) {
      this.logger.log(`image=${imageId} lost duplicate race to image=${result.duplicateOf.id}`);
      await this.storage.deleteMany([procKey]);
      return 'REJECTED';
    }

    this.logger.log(
      `image=${imageId} ACCEPTED blur=${decoded.blurScore.toFixed(0)} face=${verdict.faceAreaRatio.toFixed(3)}`,
    );

    // Hand off to the media pipeline. The accept is already committed, so a failure here must not
    // fail (and retry) validation: the pipeline reconciler starts any accepted image without a job.
    await this.mediaPipeline
      .start(imageId)
      .catch((err: Error) =>
        this.logger.error(`image=${imageId} pipeline start failed, reconciler will retry: ${err.message}`),
      );
    return 'ACCEPTED';
  }

  private async reject(
    imageId: string,
    code: RejectionCode,
    reason: string,
    metrics: ProcessingMetrics = {},
  ): Promise<PipelineOutcome> {
    await this.repo.reject(imageId, code, reason, metrics);
    this.logger.log(`image=${imageId} REJECTED code=${code}`);
    return 'REJECTED';
  }
}
