import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  createEmailProvider,
  EMAIL_JOB_OPTIONS,
  EMAIL_QUEUE,
  type EmailMessage,
  type EmailProvider,
  type InviteEmailTracking,
  SEND_EMAIL_JOB,
  type SendEmailJobData,
} from '@repairos/email';
import { Queue } from 'bullmq';
import { CONFIG, type AppConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

/** Parses REDIS_URL into ioredis/BullMQ connection options. */
export function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
  };
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

/**
 * Sends email after the change that triggered it has committed.
 *  - queue mode (dev/prod): adds a job to the BullMQ `email` queue; apps/worker sends it with 3 attempts and
 *    updates the invite's `emailStatus`.
 *  - sync mode (tests, or EMAIL_DELIVERY=sync): sends in-process and updates `emailStatus` right away.
 * Never throws: a failure is logged (without the message body, which holds the link) and recorded as FAILED.
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly logger = new Logger('EmailService');
  private queue: Queue<SendEmailJobData> | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  get mode(): 'queue' | 'sync' {
    return this.config.emailDelivery;
  }

  async dispatch(message: EmailMessage, track?: InviteEmailTracking): Promise<void> {
    if (this.config.emailDelivery === 'queue') {
      try {
        await this.getQueue().add(SEND_EMAIL_JOB, { message, ...(track ? { track } : {}) }, EMAIL_JOB_OPTIONS);
      } catch (err) {
        this.logger.error(`Could not queue email (${err instanceof Error ? err.message : String(err)})`);
        if (track) await this.markInvite(track, 'FAILED');
      }
      return;
    }
    try {
      await this.provider.send(message);
      if (track) await this.markInvite(track, 'SENT');
    } catch (err) {
      this.logger.error(`Email send failed (${err instanceof Error ? err.message : String(err)})`);
      if (track) await this.markInvite(track, 'FAILED');
    }
  }

  /** Only updates the invite if no newer send superseded this one. */
  private async markInvite(track: InviteEmailTracking, status: 'SENT' | 'FAILED'): Promise<void> {
    try {
      await this.prisma
        .forShop({ shopId: track.shopId })
        .client.invitation.updateMany({ where: { id: track.invitationId, sendCount: track.sendCount }, data: { emailStatus: status } });
    } catch (err) {
      this.logger.error(`Could not update invite email status (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  private getQueue(): Queue<SendEmailJobData> {
    if (!this.queue) {
      this.queue = new Queue<SendEmailJobData>(EMAIL_QUEUE, {
        connection: { ...redisConnection(this.config.redisUrl), maxRetriesPerRequest: 3, enableOfflineQueue: false },
      });
      this.queue.on('error', (err) => this.logger.warn(`email queue: ${err.message}`));
    }
    return this.queue;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}

export const emailProviderFactory = {
  provide: EMAIL_PROVIDER,
  inject: [CONFIG],
  useFactory: (config: AppConfig) => createEmailProvider(config.email),
};
