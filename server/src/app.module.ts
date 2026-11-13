import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env';
import { PrismaModule } from './prisma/prisma.service';
import { StorageModule } from './storage/storage.service';
import { ImagesModule } from './images/images.module';
import { HealthModule } from './health/health.controller';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    StorageModule,
    BullModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => {
        const url = new URL(env.REDIS_URL);
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            username: url.username || undefined,
            password: url.password || undefined,
            tls: url.protocol === 'rediss:' ? {} : undefined,
          },
        };
      },
    }),
    // Per-IP rate limit. Generous default because the UI polls; uploads have a tighter limit.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
    ImagesModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
