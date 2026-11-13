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
import { ImageStatus, RejectionCode } from '@prisma/client';

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
}

export interface ImagePage {
  items: ImageDto[];
  nextCursor: string | null;
}
