-- CreateEnum
CREATE TYPE "ImageStatus" AS ENUM ('PENDING', 'PROCESSING', 'ACCEPTED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "RejectionCode" AS ENUM ('FILE_TOO_SMALL', 'FILE_TOO_LARGE', 'UNSUPPORTED_FORMAT', 'CORRUPT_IMAGE', 'RESOLUTION_TOO_LOW', 'BLURRY', 'DUPLICATE', 'NO_FACE', 'MULTIPLE_FACES', 'FACE_TOO_SMALL');

-- CreateTable
CREATE TABLE "images" (
    "id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "original_filename" VARCHAR(255) NOT NULL,
    "detected_mime_type" VARCHAR(32),
    "size_bytes" INTEGER NOT NULL,
    "status" "ImageStatus" NOT NULL DEFAULT 'PENDING',
    "rejection_code" "RejectionCode",
    "rejection_reason" TEXT,
    "error_message" TEXT,
    "original_key" TEXT,
    "processed_key" TEXT,
    "thumbnail_key" TEXT,
    "processed_mime_type" VARCHAR(32),
    "width" INTEGER,
    "height" INTEGER,
    "blur_score" DOUBLE PRECISION,
    "face_count" INTEGER,
    "face_area_ratio" DOUBLE PRECISION,
    "content_hash" CHAR(64),
    "perceptual_hash" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "images_collection_id_status_created_at_id_idx" ON "images"("collection_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "images_collection_id_created_at_id_idx" ON "images"("collection_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "images_status_created_at_idx" ON "images"("status", "created_at");
-- Hand-written: Prisma can't express partial indexes.
-- At most one ACCEPTED image per exact file content within a collection, enforced by the DB.
CREATE UNIQUE INDEX "images_collection_content_hash_accepted_key"
  ON "images" ("collection_id", "content_hash")
  WHERE "status" = 'ACCEPTED';
