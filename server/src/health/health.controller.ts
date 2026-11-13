import { Controller, Get, HttpException, HttpStatus, Module } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ImageQueue } from '../images/images.queue';
import { ImagesModule } from '../images/images.module';

/** Real dependency checks (not just "process is up"), so a load balancer can route around a broken node. */
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: ImageQueue,
  ) {}

  @Get()
  async check() {
    const checks = await Promise.all([
      probe('database', () => this.prisma.$queryRaw`SELECT 1`),
      probe('queue', () => this.queue.depth()),
      probe('storage', () => this.storage.ping()),
    ]);
    const body = {
      status: checks.every((c) => c.ok) ? 'ok' : 'degraded',
      checks: Object.fromEntries(checks.map((c) => [c.name, c.ok ? 'ok' : c.error])),
      queue: checks.find((c) => c.name === 'queue')?.value ?? null,
    };
    if (body.status !== 'ok') throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}

async function probe(name: string, fn: () => Promise<unknown>) {
  try {
    const value = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2_000)),
    ]);
    return { name, ok: true as const, value };
  } catch (err) {
    return { name, ok: false as const, error: (err as Error).message || 'error', value: undefined };
  }
}

@Module({ imports: [ImagesModule], controllers: [HealthController] })
export class HealthModule {}
