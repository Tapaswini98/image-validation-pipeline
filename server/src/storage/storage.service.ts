import { Global, Inject, Injectable, Module } from '@nestjs/common';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ENV, type Env } from '../config/env';

/**
 * Thin wrapper over S3 (works with MinIO / R2 via S3_ENDPOINT).
 * - One client per process (the SDK pools connections internally).
 * - Bucket is private; reads go through short-lived presigned URLs.
 * - Keys are server-generated UUIDs: user filenames never touch the key (no path traversal).
 */
@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  /** Signs browser-facing URLs. Differs from `s3` only when the internal and public endpoints differ (Docker). */
  private readonly presigner: S3Client;
  private readonly bucket: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.bucket = env.S3_BUCKET;
    this.s3 = this.client(env.S3_ENDPOINT);
    // In docker-compose the API reaches S3 at http://s3:9090, but the browser can't resolve "s3",
    // so presigned URLs are signed against the public endpoint (http://localhost:9090).
    this.presigner = env.S3_PUBLIC_ENDPOINT ? this.client(env.S3_PUBLIC_ENDPOINT) : this.s3;
  }

  private client(endpoint: string | undefined): S3Client {
    return new S3Client({
      region: this.env.S3_REGION,
      endpoint,
      forcePathStyle: Boolean(endpoint), // S3-compatible servers need path-style addressing
      credentials:
        this.env.S3_ACCESS_KEY_ID && this.env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: this.env.S3_ACCESS_KEY_ID, secretAccessKey: this.env.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty body for s3://${this.bucket}/${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async deleteMany(keys: Array<string | null | undefined>): Promise<void> {
    const objects = keys.filter((k): k is string => Boolean(k)).map((Key) => ({ Key }));
    if (objects.length === 0) return;
    await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } }));
  }

  /** Signing is a local HMAC computation: no network call, cheap to do per list item. */
  presignGet(key: string): Promise<string> {
    return getSignedUrl(this.presigner, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: this.env.PRESIGNED_URL_TTL_SECONDS,
    });
  }

  async ping(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
