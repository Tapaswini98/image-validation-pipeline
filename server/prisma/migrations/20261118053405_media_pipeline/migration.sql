-- CreateEnum
CREATE TYPE "PipelineStatus" AS ENUM ('QUEUED', 'CONVERTING', 'COMPRESSING', 'GENERATING_VARIANTS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('CONVERSION', 'COMPRESSION', 'VARIANTS');

-- CreateEnum
CREATE TYPE "VariantKind" AS ENUM ('THUMBNAIL', 'WEB', 'FULL');

-- CreateTable
CREATE TABLE "processing_jobs" (
    "image_id" UUID NOT NULL,
    "status" "PipelineStatus" NOT NULL DEFAULT 'QUEUED',
    "run" INTEGER NOT NULL DEFAULT 1,
    "failed_stage" "PipelineStage",
    "error_message" TEXT,
    "converted_key" TEXT,
    "converted_bytes" INTEGER,
    "compressed_key" TEXT,
    "compressed_bytes" INTEGER,
    "compression_ratio" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "converted_at" TIMESTAMP(3),
    "compressed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("image_id")
);

-- CreateTable
CREATE TABLE "image_variants" (
    "image_id" UUID NOT NULL,
    "kind" "VariantKind" NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mime_type" VARCHAR(32) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "image_variants_pkey" PRIMARY KEY ("image_id","kind")
);

-- CreateIndex
CREATE INDEX "processing_jobs_status_updated_at_idx" ON "processing_jobs"("status", "updated_at");

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_variants" ADD CONSTRAINT "image_variants_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;
