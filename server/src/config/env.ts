import { z } from 'zod';

/**
 * All configuration is validated once at boot. A typo in .env crashes the process
 * immediately with a readable error instead of failing on the first upload.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  /** api = HTTP only, worker = queue consumer only, all = both in one process (local dev). */
  PROCESS_ROLE: z.enum(['api', 'worker', 'all']).default('all'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6380'),

  // Storage (S3 or any S3-compatible service such as MinIO / R2)
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().url().optional(), // set for S3-compatible servers; omit for real S3
  S3_PUBLIC_ENDPOINT: z.string().url().optional(), // browser-reachable endpoint for presigned URLs, if different
  S3_ACCESS_KEY_ID: z.string().optional(), // falls back to the default AWS credential chain
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  // Face detection: "rekognition" (AWS) or "stub" (dev only, every image has one face)
  FACE_DETECTOR: z.enum(['rekognition', 'stub']).default('rekognition'),
  REKOGNITION_REGION: z.string().default('us-east-1'),

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
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat `KEY=` (empty) as unset, so .env / docker-compose can switch optional settings off,
  // e.g. S3_ENDPOINT= to use real AWS S3 instead of the local S3-compatible server.
  source = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.refine((e) => !(e.NODE_ENV === 'production' && e.FACE_DETECTOR === 'stub'), {
    message: 'FACE_DETECTOR=stub is not allowed in production',
    path: ['FACE_DETECTOR'],
  }).safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
