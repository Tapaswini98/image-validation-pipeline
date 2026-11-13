import { Inject, Injectable } from '@nestjs/common';
import { DetectFacesCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { ENV, type Env } from '../../config/env';
import type { DetectedFace } from '../validation/face-rules';

/** Port: the pipeline depends on this interface, not on AWS. Tests inject a fake. */
export interface FaceDetector {
  detect(jpeg: Buffer): Promise<DetectedFace[]>;
}
export const FACE_DETECTOR = Symbol('FACE_DETECTOR');

/**
 * AWS Rekognition DetectFaces. Chosen over a local model (face-api.js / ONNX) because it is
 * accurate out of the box and keeps the worker image small. Tradeoffs: ~$1 per 1000 images,
 * network latency, and photos leave our infrastructure. A self-hosted ONNX detector
 * (e.g. YuNet / RetinaFace) would drop in behind this same interface.
 *
 * Errors are NOT caught here: a throttle or outage must fail the job so BullMQ retries it,
 * instead of being recorded as "no face" (a wrong rejection) or silently passing.
 */
@Injectable()
export class RekognitionFaceDetector implements FaceDetector {
  private readonly client: RekognitionClient;

  constructor(@Inject(ENV) env: Env) {
    this.client = new RekognitionClient({ region: env.REKOGNITION_REGION, maxAttempts: 3 });
  }

  async detect(jpeg: Buffer): Promise<DetectedFace[]> {
    const res = await this.client.send(
      new DetectFacesCommand({ Image: { Bytes: jpeg }, Attributes: ['DEFAULT'] }),
    );
    return (res.FaceDetails ?? []).map((f) => ({
      confidence: f.Confidence ?? 0,
      box: {
        left: f.BoundingBox?.Left ?? 0,
        top: f.BoundingBox?.Top ?? 0,
        width: f.BoundingBox?.Width ?? 0,
        height: f.BoundingBox?.Height ?? 0,
      },
    }));
  }
}
