import { z } from 'zod';

/**
 * All configuration is validated once at boot. A typo in .env crashes the process
 * immediately with a readable error instead of failing on the first upload.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  /**
   * api = HTTP only; worker = validation consumer; conversion / compression / variants = one
   * media-pipeline stage each (deployed and scaled independently); all = everything (local dev).
   */
  PROCESS_ROLE: z.enum(['api', 'worker', 'conversion', 'compression', 'variants', 'all']).default('all'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6380'),

  // Storage: a private AWS S3 bucket. Credentials come from the default AWS chain
  // (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, a profile, or an instance role).
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1),
  PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  // Face detection: AWS Rekognition (same credentials as S3). Defaults to S3_REGION.
  REKOGNITION_REGION: z.string().min(1).optional(),
  /** none = local/demo mode without AWS: the face check is skipped (every image counts as one clear face). */
  FACE_DETECTOR: z.enum(['rekognition', 'none']).default('rekognition'),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  // Validation thresholds: tunable without a deploy
  MIN_FILE_BYTES: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(10 * 1024),
  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(20 * 1024 * 1024),
  MIN_DIMENSION_PX: z.coerce.number().int().positive().default(512),
  BLUR_THRESHOLD: z.coerce.number().positive().default(40),
  SIMILARITY_MAX_HAMMING: z.coerce.number().int().min(0).max(64).default(6),
  MIN_FACE_CONFIDENCE: z.coerce.number().min(0).max(100).default(90),
  MIN_FACE_AREA_RATIO: z.coerce.number().min(0).max(1).default(0.04),
  MIN_FACE_SIZE_PX: z.coerce.number().int().positive().default(100),

  // Media pipeline
  COMPRESSION_QUALITY: z.coerce.number().int().min(30).max(95).default(80),
  THUMBNAIL_MAX_PX: z.coerce.number().int().positive().default(256),
  WEB_MAX_PX: z.coerce.number().int().positive().default(1280),
  UPLOAD_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
});

const ResolvedEnvSchema = EnvSchema.transform((e) => ({
  ...e,
  REKOGNITION_REGION: e.REKOGNITION_REGION ?? e.S3_REGION,
}));

export type Env = z.infer<typeof ResolvedEnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat `KEY=` (empty) as unset, so a blank line in .env falls back to the default
  // (or fails validation for required keys) instead of becoming an empty string.
  source = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = ResolvedEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
