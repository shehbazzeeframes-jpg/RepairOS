/**
 * RepairOS worker: processes the `default` queue (ping) and the `email` queue (invites, password resets).
 */
import { assertAppRole, createPrismaClient, type PrismaClient, tenantDb } from '@repairos/db';
import { createEmailProvider, EMAIL_QUEUE, type InviteEmailTracking, loadEmailConfig, type SendEmailJobData } from '@repairos/email';
import { Worker } from 'bullmq';
import { pino } from 'pino';
import { processEmailJob } from './email-jobs';
import { processJob, QUEUE_DEFAULT, redisConnection } from './jobs';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', name: 'worker' });

async function main() {
  // D6: refuses to start in production without RESEND_API_KEY and EMAIL_FROM.
  const emailConfig = loadEmailConfig();
  const provider = createEmailProvider(emailConfig);
  const connection = redisConnection(process.env.REDIS_URL ?? 'redis://localhost:6379');

  // Delivery tracking writes invitations.emailStatus as the RLS-bound app role.
  let prisma: PrismaClient | null = null;
  if (process.env.APP_DATABASE_URL) {
    prisma = createPrismaClient(process.env.APP_DATABASE_URL);
    await assertAppRole(prisma);
  } else {
    logger.warn('APP_DATABASE_URL is not set: invite email status will not be tracked');
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
  for (const w of workers) {
    w.on('ready', () => logger.info({ queue: w.name, provider: provider.name }, 'worker ready'));
    // Never log job.data: email jobs carry invite links.
    w.on('failed', (job, err) => logger.error({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed'));
  }

  async function shutdown(signal: string) {
    logger.info({ signal }, 'shutting down');
    await Promise.all(workers.map((w) => w.close()));
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
