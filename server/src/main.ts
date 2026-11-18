import './load-env'; // must be first: module files read PROCESS_ROLE at import time
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();

  if (env.PROCESS_ROLE !== 'api' && env.PROCESS_ROLE !== 'all') {
    // Queue consumers only (validation or one pipeline stage): no HTTP server.
    const ctx = await NestFactory.createApplicationContext(AppModule);
    ctx.enableShutdownHooks(); // SIGTERM -> BullMQ finishes active jobs before exit
    Logger.log(`Worker started: role=${env.PROCESS_ROLE} concurrency=${env.WORKER_CONCURRENCY}`, 'Bootstrap');
    return;
  }

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.enableCors({
    origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST', 'DELETE'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(env.PORT);
  Logger.log(`API listening on http://localhost:${env.PORT} (role=${env.PROCESS_ROLE})`, 'Bootstrap');
}

void bootstrap();
