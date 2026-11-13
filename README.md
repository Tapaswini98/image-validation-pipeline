# Photo Upload & Validation Pipeline

Users upload photos of themselves. Each photo is stored, validated in a background worker, and sorted into **Accepted** or **Rejected** with a specific, human-readable reason.

**Stack:** Next.js 16 (React 19) · NestJS 11 (Express) · PostgreSQL 16 + Prisma · BullMQ + Redis · S3 (AWS SDK v3) · sharp · AWS Rekognition

---

## Contents

1. [Quick start](#quick-start)
2. [Architecture](#architecture)
3. [Validation pipeline](#validation-pipeline)
4. [Key decisions and tradeoffs](#key-decisions-and-tradeoffs)
5. [Data model](#data-model)
6. [API](#api)
7. [Security](#security)
8. [Testing](#testing)
9. [QA checklist](#qa-checklist)
10. [What I would do next](#what-i-would-do-next)

---

## Quick start

Requires Node 20.12+, Docker, and an AWS account. Storage is a **private AWS S3 bucket** and face detection is **AWS Rekognition**. There is no local S3 emulator or fake face detector.

### 1. AWS

Create a private S3 bucket and an IAM user with:

- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::your-bucket-name/*`
- `s3:ListBucket` on `arn:aws:s3:::your-bucket-name` (the health check uses it)
- `rekognition:DetectFaces`

Put the values in a root `.env` (gitignored; Docker Compose reads it):

```
S3_BUCKET=your-bucket-name
S3_REGION=your-bucket-region
REKOGNITION_REGION=your-region        # optional, defaults to S3_REGION
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

### 2. Database migration (first run only)

The repo ships the Prisma schema but no migration files, so create the first migration:

```bash
docker compose up -d postgres redis
cd server && npm install
npx prisma migrate dev --name init --create-only
```

Prisma can't express partial indexes, so append this to the generated `prisma/migrations/<timestamp>_init/migration.sql` before applying it:

```sql
-- At most one ACCEPTED image per exact file content within a collection, enforced by the DB.
CREATE UNIQUE INDEX "images_collection_content_hash_accepted_key"
  ON "images" ("collection_id", "content_hash")
  WHERE "status" = 'ACCEPTED';
```

Then apply it with `npx prisma migrate dev`, and commit the `prisma/migrations` folder.

### 3a. Everything in Docker

```bash
docker compose up --build                  # UI http://localhost:3000 · API http://localhost:3001
```

This starts Postgres, Redis, a one-shot `migrate` job, the **API**, a separate **worker**, and the **client**. Scale the workers with `docker compose up --build --scale worker=3`. `docker compose down -v` wipes Postgres and Redis; S3 objects stay in the bucket.

### 3b. Local development (hot reload)

```bash
docker compose up -d postgres redis        # infrastructure only: Postgres :5433, Redis :6380

cd server
cp .env.example .env                       # fill in the AWS section
npm install
npm run db:migrate
npm run start:dev                          # API + worker on :3001

cd ../client
npm install
npm run dev                                # UI on http://localhost:3000
```

In production the API and worker run as separate processes from the same build:

```bash
npm run start:api      # PROCESS_ROLE=api: HTTP only
npm run start:worker   # PROCESS_ROLE=worker: queue consumer only, scale horizontally
```

---

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[Next.js UI<br/>useReducer state machine]
  end
  subgraph API["API (NestJS)"]
    C[POST /images<br/>size + magic-byte check]
  end
  subgraph Worker["Worker (BullMQ consumer)"]
    P[Pipeline:<br/>decode · resolution · blur ·<br/>duplicate · faces]
  end
  UI -- "1 file per request<br/>(3 in parallel, progress bars)" --> C
  C -- original --> S3[(S3<br/>private bucket)]
  C -- "row: PENDING" --> PG[(PostgreSQL)]
  C -- "job (jobId = imageId)" --> R[(Redis)]
  C -- "202 + record" --> UI
  R --> P
  P <--> S3
  P -- "ACCEPTED / REJECTED + reason" --> PG
  P -- DetectFaces --> RK[AWS Rekognition]
  UI -- "poll GET /images?ids=…<br/>(one request for all in-flight)" --> PG
```

**Request path (fast, about 50 ms):** validate size, sniff magic bytes, `PUT` the original to S3, `INSERT` a `PENDING` row, enqueue, return `202`.

**Worker path (slow, CPU and network heavy):** HEIC conversion, decoding, the quality checks and the Rekognition call. If processing ran inside the request, a 50-photo upload from one user could block the API for everyone. The queue also gives retries with backoff, back-pressure, and the ability to scale workers separately from the API.

### Image lifecycle

```
PENDING ──► PROCESSING ──► ACCEPTED
                      ├──► REJECTED   (validation outcome, terminal, has rejection_code + reason)
                      └──► FAILED     (infrastructure error after all retries; user can retry)
```

Size and format failures are rejected synchronously at intake, so they are never stored in S3 or queued.

---

## Validation pipeline

The worker runs the checks cheapest first and calls the paid external API as late as possible:

| # | Check | How | Rejection code |
|---|---|---|---|
| 0 | File size | `10 KB ≤ size ≤ 20 MB` (the upper limit is enforced by multer while streaming → 413) | `FILE_TOO_SMALL` |
| 0 | Format | **Magic bytes**, not the client's `Content-Type` (JPEG `FFD8FF`, PNG signature, HEIC `ftyp` brand) | `UNSUPPORTED_FORMAT` |
| 1 | Decode / convert | HEIC → JPEG (`heic-convert`); EXIF orientation applied; metadata stripped | `CORRUPT_IMAGE` |
| 2 | Resolution | Shortest side ≥ 512 px | `RESOLUTION_TOO_LOW` |
| 3 | Blur | **Variance of the Laplacian**, taken from the sharpest region of a 4×4 grid at 1024 px | `BLURRY` |
| 4 | Duplicate (pre-check) | SHA-256 (exact) **or** dHash Hamming distance ≤ 6 (near), within the user's collection | `DUPLICATE` |
| 5 | Faces | Rekognition `DetectFaces`; only detections with confidence ≥ 90 count | `NO_FACE`, `MULTIPLE_FACES`, `FACE_TOO_SMALL` |
| 6 | Duplicate (final) | Same check, **under a per-collection advisory lock**, together with the accept, in one transaction | `DUPLICATE` |

All thresholds are environment variables (`BLUR_THRESHOLD`, `SIMILARITY_MAX_HAMMING`, `MIN_FACE_AREA_RATIO`, …). Each check stores its measured value (`blur_score`, `face_area_ratio`, `face_count`), so thresholds can be tuned against real data.

---

## Key decisions and tradeoffs

| Decision | Why | Tradeoff / alternative |
|---|---|---|
| **Async worker (BullMQ)** instead of processing in the request | HEIC decode and face detection take about 1–3 s per image and are CPU-bound; the queue gives retries with exponential backoff, back-pressure, and separate scaling | More moving parts (Redis). A Postgres-backed queue (pg-boss) would avoid Redis at lower throughput. |
| **One file per request**, 3 in parallel (client) | Per-file progress bars and retries; one bad file or dropped connection doesn't fail a 50-file batch | More HTTP requests. At large scale, **presigned direct-to-S3 uploads** would take file bytes off the API entirely. |
| **Store the original first, then validate** | The job's input is durable in S3, so a worker crash or retry never loses the upload, and images can be reprocessed if thresholds change | Rejected originals use storage → an S3 lifecycle rule to expire `originals/` after N days |
| **Duplicate scope = collection** (one user's photo set) | "Too similar" matters inside one person's set; two users can legitimately upload similar photos. It also keeps the similarity scan to tens of rows. | Needs a user/collection identity. `collectionId` stands in for `userId` until auth exists. |
| **Advisory lock + partial unique index** for duplicates | A plain "check then insert" lets two concurrent near-duplicates both pass (check-then-act race). The lock serializes only the same collection, for milliseconds. | A global lock would serialize all users; optimistic retries would add complexity. |
| **Hamming distance in SQL** (`bit_count((a # b)::bit(64))`) | No hashes pulled into Node; one indexed query | Linear in the collection's accepted images. For a global index use multi-index hashing or pgvector `bit` + HNSW. |
| **dHash** over aHash | Robust to resizing, re-compression and brightness changes | Not robust to crops or rotations; embeddings (CLIP or face embeddings) would also catch "same pose, different shot" |
| **Laplacian variance, regional max** | Standard focus measure. The regional max avoids rejecting portraits with a blurred background (bokeh). | A heuristic: the threshold must be calibrated on labelled photos. The best signal is sharpness *inside the face box*. |
| **Rekognition** for faces | Accurate, no model hosting, small worker image | About $1 per 1,000 images, network latency, photos leave our infrastructure. A self-hosted ONNX detector (YuNet/RetinaFace) fits behind the same `FaceDetector` interface. |
| **Detector errors fail the job** (and are retried), not "no face" | An outage must not become a wrong rejection, or a silent pass | The user sees `FAILED` + Retry after 3 attempts |
| **PostgreSQL + Prisma** | Relational integrity, enums, partial indexes, transactions and advisory locks were all needed above | Prisma can't express partial indexes, so the partial unique index is hand-added to the migration SQL (see Quick start) |
| **Keyset (cursor) pagination** | Constant cost at any page depth; stable while new uploads arrive | No "jump to page N" |
| **Private bucket + presigned URLs (15 min)** | Images are never publicly listable; access can be revoked | URLs expire, so the client re-fetches them |

---

## Data model

One table, `images` (see [`server/prisma/schema.prisma`](server/prisma/schema.prisma)):

- `status` (`ImageStatus` enum), `rejection_code` (`RejectionCode` enum), `rejection_reason` (shown to the user), `error_message` (internal, for `FAILED`)
- `original_key`, `processed_key`, `thumbnail_key`: S3 keys derived only from the server-generated UUID (user filenames never become keys)
- Metrics: `width`, `height`, `blur_score`, `face_count`, `face_area_ratio`, `content_hash` (SHA-256), `perceptual_hash` (BIGINT)

Indexes:

| Index | Serves |
|---|---|
| `(collection_id, status, created_at DESC, id DESC)` | The Accepted/Rejected list with keyset pagination, and the duplicate scan |
| `(collection_id, created_at DESC, id DESC)` | The "all images" list |
| `(status, created_at)` | The reconciler that re-enqueues lost `PENDING` jobs |
| `UNIQUE (collection_id, content_hash) WHERE status = 'ACCEPTED'` | A database-level guarantee against exact duplicates |

---

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/images` | `multipart/form-data`: `file`, `collectionId`. Returns **202** with the record (`PENDING`, or `REJECTED` for size/format). |
| `GET` | `/images?collectionId=&status=&limit=&cursor=` | Keyset-paginated list → `{ items, nextCursor }` |
| `GET` | `/images?collectionId=&ids=a,b,c` | Batch status lookup (used for polling, max 100) |
| `GET` | `/images/:id` | One image |
| `POST` | `/images/:id/retry` | Re-queue a `FAILED` image (409 otherwise) |
| `DELETE` | `/images/:id` | Delete the row and its S3 objects → 204 |
| `GET` | `/health` | Checks the DB, Redis and S3, and reports queue depth; 503 if any check fails |

Example response:

```json
{
  "id": "8f38d865-…",
  "filename": "beach.jpg",
  "status": "REJECTED",
  "rejectionCode": "BLURRY",
  "rejectionReason": "Photo is too blurry (sharpness 12, minimum 40). Use a photo that is in focus.",
  "width": 3024, "height": 4032,
  "metrics": { "blurScore": 12.4, "faceCount": null, "faceAreaRatio": null },
  "url": null,
  "thumbnailUrl": "https://…presigned…",
  "createdAt": "…", "processedAt": "…"
}
```

---

## Security

- **File type from magic bytes**, never the `Content-Type` header or file extension
- **Size limits enforced while streaming** (multer `limits`), so oversized bodies are cut off with 413
- **Decompression-bomb guard:** `limitInputPixels` of 80 MP
- **EXIF stripped** on re-encode (removes GPS location and device details)
- **Server-generated object keys** (no path traversal); filenames sanitized and only ever displayed
- **Private bucket**, short-lived presigned reads
- **Input validation** with `class-validator` (`whitelist` + `forbidNonWhitelisted`); config validated with zod at boot
- **Rate limiting** with `@nestjs/throttler` (stricter on uploads)
- Internal fields (S3 keys, hashes, raw errors) are never returned by the API

Not done (no auth in scope): `collectionId` is a client-held UUID standing in for the authenticated user. In production it comes from the session, and every query is scoped by it to prevent IDOR.

---

## Testing

```bash
cd server && npm test            # 43 unit tests
cd server && npm run test:int    # 4 integration tests against real Postgres (Postgres up and migrated first)
cd client && npm test            # 12 reducer + grouping tests
cd server && npm run fixtures    # generates QA files (blurry, low-res, duplicate copies, corrupt, EXIF-rotated, …)
```

- **Validators:** tested on **generated images** (sharp + SVG), so there are no binary fixtures and every test states the property it depends on (blurred vs sharp, bokeh portrait, resized copy, EXIF-rotated, corrupt JPEG, AVIF-vs-HEIC brands).
- **Pipeline:** real decoding and hashing; only the boundaries are faked (S3, DB, face detector). Covers every rejection path, check ordering (no paid API call for blurry or low-resolution images), outage → retry, and idempotent replays.
- **Race condition (integration):** 10 near-duplicates accepted concurrently on real Postgres → exactly 1 `ACCEPTED`, 9 `DUPLICATE`.

---

## QA checklist

| Scenario | Expected |
|---|---|
| Clear single-face JPEG portrait ≥ 512 px | **Accepted**; the "Uploaded Images" bar moves towards 6 (minimum) / 10 |
| Any rejected photo | Short label under the thumbnail ("Blurry face detected", "Face is too far away", …); hover or focus it for the specific reason |
| iPhone HEIC portrait | Preview converted in the browser → **Accepted**; stored as JPEG |
| `.gif`, `.webp`, `.txt` renamed to `.jpg` | **Rejected** instantly (client) or at intake (server, by magic bytes) |
| 50×50 icon / 300×300 photo | **Rejected**: file too small / resolution too low |
| Out-of-focus or motion-blurred photo | **Rejected**: too blurry (with score) |
| Portrait with a blurred background but a sharp face | **Accepted** |
| Same photo again, or a resized/re-saved copy | **Rejected**: too similar to *"original.jpg"* |
| The same photo dropped 5× at once | 1 Accepted, 4 Duplicate (race-safe) |
| Group photo | **Rejected**: N faces detected |
| Distant subject (small face) | **Rejected**: face too small (% of frame, px) |
| Landscape, no person | **Rejected**: no face detected |
| Rekognition unavailable (bad credentials) | Retried with backoff → **Error** + Retry button; never falsely rejected |
| `kill -9` the worker mid-batch, restart it | Nothing lost: the in-flight job is re-delivered once its lock expires (~30 s), queued jobs continue |
| Stop Redis, upload, start Redis | Upload still returns 202 within ~2 s (`PENDING`); processed once Redis is back |
| Reload the page | Server-side results reload from Postgres |
| "Start a new set" | Fresh collection; earlier photos no longer count as duplicates |

---

## What I would do next

1. **Auth:** derive `collectionId`/`userId` from the session and enforce ownership on every query.
2. **Presigned direct-to-S3 uploads** to take file bytes off the API.
3. **Face-region sharpness:** measure blur inside the Rekognition bounding box.
4. **Calibrate thresholds** on a labelled set of real accepted and rejected photos (the metrics are already stored per image).
5. **Push updates over SSE/WebSocket** instead of polling.
6. **Observability:** structured JSON logs (pino) with an image ID per log line, queue-depth and per-rejection-code metrics, and a Bull Board dashboard.
7. **S3 lifecycle rules** to expire rejected originals, plus a sweep for orphaned objects.
8. **CI** running lint, unit and integration tests on every push.
