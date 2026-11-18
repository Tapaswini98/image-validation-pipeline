/**
 * Load test: submits many images concurrently through the real API (validation -> media pipeline),
 * prints queue backlog per stage while they drain, then a report from the database.
 *
 *   npx ts-node --transpile-only scripts/load-test.ts --dir ~/photos --count 200 --concurrency 20
 *
 * --dir          folder of face photos (jpg/png/heic). Files are cycled to reach --count.
 *                Each upload gets its own collectionId, so re-using a file is not a duplicate.
 * --count        number of uploads (default 200)
 * --concurrency  parallel uploads in flight (default 20)
 * --api          API base URL (default http://localhost:3001)
 * --timeout      give up waiting after N seconds (default 900)
 *
 * Needs DATABASE_URL (server/.env) for the final report. Raise UPLOAD_RATE_LIMIT_PER_MIN on the API
 * (default 120/min per IP); 429s are retried with backoff anyway.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';

try {
  process.loadEnvFile();
} catch {
  /* rely on the environment */
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, cur, i, all) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const API = args.api ?? 'http://localhost:3001';
const COUNT = Number(args.count ?? 200);
const CONCURRENCY = Number(args.concurrency ?? 20);
const TIMEOUT_S = Number(args.timeout ?? 900);
const DIR = args.dir?.replace(/^~/, process.env.HOME ?? '~');

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
};

interface Upload {
  id?: string;
  file: string;
  httpStatus: number;
  ms: number;
  retries: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function uploadOne(path: string): Promise<Upload> {
  const bytes = readFileSync(path);
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('collectionId', randomUUID());
    form.append('file', new Blob([bytes], { type: MIME[extname(path).toLowerCase()] }), basename(path));
    const res = await fetch(`${API}/images`, { method: 'POST', body: form });
    if (res.status === 429 && attempt < 8) {
      await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return {
      id: body.id,
      file: basename(path),
      httpStatus: res.status,
      ms: Date.now() - started,
      retries: attempt,
    };
  }
}

async function main() {
  if (!DIR) throw new Error('--dir <folder of face photos> is required');
  const files = readdirSync(DIR)
    .filter((f) => MIME[extname(f).toLowerCase()])
    .map((f) => join(DIR, f));
  if (!files.length) throw new Error(`no jpg/png/heic files in ${DIR}`);

  const prisma = new PrismaClient();
  console.log(
    `Load test: ${COUNT} uploads, ${CONCURRENCY} concurrent, ${files.length} source files, API ${API}\n`,
  );

  // ---- 1. submit, with a fixed number in flight ----
  const t0 = Date.now();
  const uploads: Upload[] = [];
  let next = 0;
  let monitorOn = true;
  const monitor = (async () => {
    while (monitorOn) {
      await sleep(2_000);
      await printStats(t0, uploads.length);
    }
  })();

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < COUNT) {
        const i = next++;
        uploads.push(await uploadOne(files[i % files.length]));
      }
    }),
  );
  const submitMs = Date.now() - t0;
  const ids = uploads.map((u) => u.id).filter((id): id is string => Boolean(id));
  console.log(
    `\nSubmitted ${ids.length}/${COUNT} in ${fmt(submitMs)} (${(ids.length / (submitMs / 1000)).toFixed(1)} uploads/s)\n`,
  );

  // ---- 2. wait until every image reached a terminal state ----
  const deadline = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    const inFlight = await prisma.image.count({
      where: {
        id: { in: ids },
        OR: [
          { status: { in: ['PENDING', 'PROCESSING'] } },
          { status: 'ACCEPTED', processingJob: { is: null } },
          { status: 'ACCEPTED', processingJob: { status: { notIn: ['COMPLETED', 'FAILED'] } } },
        ],
      },
    });
    if (inFlight === 0) break;
    await sleep(2_000);
  }
  monitorOn = false;
  await monitor;

  await report(prisma, uploads, ids, t0);
  await prisma.$disconnect();
}

async function printStats(t0: number, submitted: number) {
  try {
    type Counts = { waiting: number; active: number; delayed: number };
    const [stats, health] = await Promise.all([
      fetch(`${API}/pipeline/stats`).then(
        (r) =>
          r.json() as Promise<{
            queues: Record<'CONVERSION' | 'COMPRESSION' | 'VARIANTS', Counts>;
            jobs: Record<string, number>;
          }>,
      ),
      fetch(`${API}/health`).then((r) => r.json() as Promise<{ queue: Counts }>),
    ]);
    const q = (s: Counts) =>
      `${String(s.waiting + s.delayed).padStart(4)} waiting ${String(s.active).padStart(2)} active`;
    const j = stats.jobs;
    console.log(
      `[${fmt(Date.now() - t0).padStart(6)}] submitted ${String(submitted).padStart(4)} | ` +
        `validation ${q(health.queue)} | conversion ${q(stats.queues.CONVERSION)} | ` +
        `compression ${q(stats.queues.COMPRESSION)} | variants ${q(stats.queues.VARIANTS)} | ` +
        `completed ${j.COMPLETED ?? 0} failed ${j.FAILED ?? 0}`,
    );
  } catch (err) {
    console.log(`  (stats unavailable: ${(err as Error).message})`);
  }
}

async function report(prisma: PrismaClient, uploads: Upload[], ids: string[], t0: number) {
  const images = await prisma.image.findMany({
    where: { id: { in: ids } },
    include: { processingJob: true, _count: { select: { variants: true } } },
  });

  const byStatus = (s: string) => images.filter((i) => i.status === s);
  const rejected = byStatus('REJECTED');
  const jobs = images.flatMap((i) => (i.processingJob ? [{ image: i, job: i.processingJob }] : []));
  const done = jobs.filter((x) => x.job.status === 'COMPLETED');
  const failed = jobs.filter((x) => x.job.status === 'FAILED');

  const ms = (a: Date | null, b: Date | null) => (a && b ? b.getTime() - a.getTime() : NaN);
  const series = (f: (x: (typeof done)[number]) => number) => done.map(f).filter((n) => !Number.isNaN(n));
  const e2e = series((x) => ms(x.image.createdAt, x.job.completedAt));
  const pipe = series((x) => ms(x.job.queuedAt, x.job.completedAt));
  const conv = series((x) => ms(x.job.queuedAt, x.job.convertedAt));
  const comp = series((x) => ms(x.job.convertedAt, x.job.compressedAt));
  const vars = series((x) => ms(x.job.compressedAt, x.job.completedAt));
  const lastDone = Math.max(...done.map((x) => x.job.completedAt!.getTime()), t0);

  const groupCount = <T>(xs: T[], key: (x: T) => string) =>
    Object.entries(
      xs.reduce<Record<string, number>>((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {}),
    )
      .map(([k, n]) => `${k}: ${n}`)
      .join(', ');

  const dupVariants = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM (
      SELECT image_id, kind FROM image_variants WHERE image_id = ANY(${ids}::uuid[])
      GROUP BY image_id, kind HAVING count(*) > 1) d`;

  const httpErrors = uploads.filter((u) => u.httpStatus >= 300);
  console.log(`
================ LOAD TEST REPORT ================
Uploads        ${uploads.length} sent, ${httpErrors.length} HTTP errors${httpErrors.length ? ` (${groupCount(httpErrors, (u) => String(u.httpStatus))})` : ''}
               latency p50 ${fmt(
                 pct(
                   uploads.map((u) => u.ms),
                   50,
                 ),
               )}  p95 ${fmt(
                 pct(
                   uploads.map((u) => u.ms),
                   95,
                 ),
               )}  (429 retries: ${uploads.reduce((a, u) => a + u.retries, 0)})
Validation     accepted ${byStatus('ACCEPTED').length}, rejected ${rejected.length}${rejected.length ? ` (${groupCount(rejected, (i) => i.rejectionCode ?? '?')})` : ''}, failed ${byStatus('FAILED').length}
Pipeline       completed ${done.length}, failed ${failed.length}${failed.length ? ` (${groupCount(failed, (x) => `${x.job.failedStage}: ${x.job.errorMessage?.slice(0, 60)}`)})` : ''}
End-to-end     upload -> variants ready   p50 ${fmt(pct(e2e, 50))}  p95 ${fmt(pct(e2e, 95))}  max ${fmt(Math.max(0, ...e2e))}
Pipeline only  queued -> completed        p50 ${fmt(pct(pipe, 50))}  p95 ${fmt(pct(pipe, 95))}
Per stage avg  conversion ${fmt(avg(conv))} | compression ${fmt(avg(comp))} | variants ${fmt(avg(vars))}   (includes queue wait)
Throughput     ${((done.length / Math.max(1, lastDone - t0)) * 60_000).toFixed(1)} images/min fully processed
Compression    avg ratio ${avg(done.map((x) => x.job.compressionRatio ?? 0)).toFixed(2)}x, ${(done.reduce((a, x) => a + (x.job.convertedBytes ?? 0), 0) / 1e6).toFixed(1)} MB -> ${(done.reduce((a, x) => a + (x.job.compressedBytes ?? 0), 0) / 1e6).toFixed(1)} MB
Integrity      ${done.filter((x) => x.image._count.variants === 3).length}/${done.length} completed images have exactly 3 variants; duplicate (image, kind) rows: ${dupVariants[0]?.n ?? 0}
==================================================`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
