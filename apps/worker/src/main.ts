/**
 * RepairOS worker: processes the `default` queue (ping), the `email` queue (invites, password resets) and the
 * `maintenance` queue (daily passcode sweep and expired idempotency-key purge, scheduled here).
 */
import { IDEMPOTENCY_WINDOW_MINUTES } from '@repairos/contracts';
import { assertAppRole, createPrismaClient, type PrismaClient, purgeExpiredIdempotencyKeys, sweepUnusedPasscodes, tenantDb } from '@repairos/db';
import { createEmailProvider, EMAIL_QUEUE, type InviteEmailTracking, type SendEmailJobData } from '@repairos/email';
import { Queue, Worker } from 'bullmq';
import { pino } from 'pino';
import { loadWorkerConfig } from './config';
import { processEmailJob } from './email-jobs';
import { processJob, QUEUE_DEFAULT, redisConnection } from './jobs';
import { MAINTENANCE_QUEUE, processMaintenanceJob, scheduleMaintenance } from './maintenance-jobs';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', name: 'worker' });

async function main() {
  // M2/D6/L5: refuses to start without NODE_ENV, and outside development/test without RESEND_API_KEY, EMAIL_FROM
  // and APP_DATABASE_URL.
  const config = loadWorkerConfig();
  const provider = createEmailProvider(config.email);
  const connection = redisConnection(config.redisUrl);

  // Delivery tracking writes invitations.emailStatus as the RLS-bound app role.
  let prisma: PrismaClient | null = null;
  if (config.appDatabaseUrl) {
    prisma = createPrismaClient(config.appDatabaseUrl);
    await assertAppRole(prisma);
  } else {
    logger.warn('APP_DATABASE_URL is not set: invite email status will not be tracked (development/test only)');
  }

  const markInvite = async (track: InviteEmailTracking, status: 'SENT' | 'FAILED') => {
    if (!prisma) return;
    try {
      await tenantDb(prisma, { shopId: track.shopId }).client.invitation.updateMany({
        where: { id: track.invitationId, sendCount: track.sendCount },
        data: { emailStatus: status },
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'could not update invite email status');
    }
  };

  const workers = [
    new Worker(QUEUE_DEFAULT, (job) => processJob(job, logger), { connection }),
    new Worker<SendEmailJobData>(EMAIL_QUEUE, (job) => processEmailJob(job, { provider, markInvite, logger }), { connection }),
  ];

  // Daily clean-ups (passcode sweep, expired idempotency keys) need the database.
  let maintenanceQueue: Queue | null = null;
  if (prisma) {
    const db = prisma;
    maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection });
    await scheduleMaintenance(maintenanceQueue);
    workers.push(
      new Worker(
        MAINTENANCE_QUEUE,
        (job) =>
          processMaintenanceJob(job, {
            sweepPasscodes: () => sweepUnusedPasscodes(db),
            purgeIdempotencyKeys: () => purgeExpiredIdempotencyKeys(db, IDEMPOTENCY_WINDOW_MINUTES),
            logger,
          }),
        { connection },
      ),
    );
  } else {
    logger.warn('APP_DATABASE_URL is not set: daily maintenance jobs are not scheduled (development/test only)');
  }
  for (const w of workers) {
    w.on('ready', () => logger.info({ queue: w.name, provider: provider.name }, 'worker ready'));
    // Never log job.data: email jobs carry invite links.
    w.on('failed', (job, err) => logger.error({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed'));
  }

  async function shutdown(signal: string) {
    logger.info({ signal }, 'shutting down');
    await Promise.all(workers.map((w) => w.close()));
    await maintenanceQueue?.close();
    await prisma?.$disconnect();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'worker failed to start');
  process.exit(1);
});
