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
 * Thin wrapper over AWS S3.
 * - One client per process (the SDK pools connections internally).
 * - Bucket is private; reads go through short-lived presigned URLs.
 * - Keys are server-generated UUIDs: user filenames never touch the key (no path traversal).
 * - Credentials come from the default AWS chain (env keys, profile or instance role).
 */
@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.bucket = env.S3_BUCKET;
    this.s3 = new S3Client({ region: env.S3_REGION });
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
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
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
