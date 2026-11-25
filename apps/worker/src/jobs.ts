import type { ConnectionOptions, Job } from 'bullmq';
import type { Logger } from 'pino';

export const QUEUE_DEFAULT = 'default';

/** Parses REDIS_URL into BullMQ connection options. */
export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null, // required by BullMQ workers
  };
}

/** Sprint 0: only a `ping` job, used to check the worker end to end. */
export async function processJob(job: Pick<Job, 'id' | 'name' | 'data'>, logger: Pick<Logger, 'info'>) {
  if (job.name === 'ping') {
    logger.info({ jobId: job.id }, 'pong');
    return { pong: true };
  }
  throw new Error(`No processor for job "${job.name}"`);
}
