/**
 * RepairOS worker (Sprint 0 stub): connects to Redis and processes the `default` BullMQ queue.
 * Real processors (messaging, reminders, low-stock alerts, exports) arrive from Sprint 3.
 */
import { Worker } from 'bullmq';
import { pino } from 'pino';
import { processJob, QUEUE_DEFAULT, redisConnection } from './jobs';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', name: 'worker' });

const worker = new Worker(QUEUE_DEFAULT, (job) => processJob(job, logger), {
  connection: redisConnection(process.env.REDIS_URL ?? 'redis://localhost:6379'),
});

worker.on('ready', () => logger.info({ queue: QUEUE_DEFAULT }, 'worker ready'));
worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'job failed'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  await worker.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
