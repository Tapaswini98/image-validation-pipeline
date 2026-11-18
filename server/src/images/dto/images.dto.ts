import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  ImageStatus,
  RejectionCode,
  type PipelineStage,
  type PipelineStatus,
  type VariantKind,
} from '@prisma/client';

export class UploadImageBody {
  /** Which photo set this belongs to. Stand-in for the authenticated user id. */
  @IsUUID()
  collectionId!: string;
}

export class ListImagesQuery {
  @IsUUID()
  collectionId!: string;

  @IsOptional()
  @IsEnum(ImageStatus)
  status?: ImageStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 30;

  @IsOptional()
  @IsString()
  cursor?: string;

  /** Batch status lookup for polling: ?ids=a,b,c (one request for all in-flight uploads). */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  ids?: string[];
}

/** Public shape. Internal fields (S3 keys, hashes, error stacks) never leave the server. */
export interface ImageDto {
  id: string;
  collectionId: string;
  filename: string;
  status: ImageStatus;
  rejectionCode: RejectionCode | null;
  rejectionReason: string | null;
  mimeType: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  metrics: { blurScore: number | null; faceCount: number | null; faceAreaRatio: number | null };
  /** Presigned, short-lived. Only for ACCEPTED images. */
  url: string | null;
  /** Presigned, short-lived. Available once the worker decoded the image (accepted or rejected). */
  thumbnailUrl: string | null;
  createdAt: string;
  processedAt: string | null;
  /** Media pipeline (null until the image is accepted). */
  pipeline: PipelineDto | null;
  /** Generated variants with presigned URLs (empty until the pipeline completes). */
  variants: VariantDto[];
}

export interface PipelineDto {
  status: PipelineStatus;
  run: number;
  failedStage: PipelineStage | null;
  error: string | null;
  compression: { inputBytes: number | null; outputBytes: number | null; ratio: number | null };
  timings: {
    queuedAt: string;
    convertedAt: string | null;
    compressedAt: string | null;
    completedAt: string | null;
    failedAt: string | null;
  };
}

export interface VariantDto {
  kind: VariantKind;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface ImagePage {
  items: ImageDto[];
  nextCursor: string | null;
}
