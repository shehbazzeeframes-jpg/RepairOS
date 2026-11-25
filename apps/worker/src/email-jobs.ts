import type { EmailProvider, InviteEmailTracking, SendEmailJobData } from '@repairos/email';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

export interface EmailJobDeps {
  provider: EmailProvider;
  /** Records the invite's delivery result; resolves even when tracking is unavailable. */
  markInvite: (track: InviteEmailTracking, status: 'SENT' | 'FAILED') => Promise<void>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

type EmailJob = Pick<Job<SendEmailJobData>, 'id' | 'data' | 'attemptsMade' | 'opts'>;

/**
 * Sends one email. Throws on failure so BullMQ retries (EMAIL_JOB_OPTIONS: 3 attempts, exponential backoff);
 * the invite becomes FAILED only after the last attempt. Logs never include the message body (it holds the link).
 */
export async function processEmailJob(job: EmailJob, deps: EmailJobDeps): Promise<{ id: string }> {
  const { message, track } = job.data;
  try {
    const result = await deps.provider.send(message);
    deps.logger.info({ jobId: job.id, provider: deps.provider.name, messageId: result.id }, 'email sent');
    if (track) await deps.markInvite(track, 'SENT');
    return result;
  } catch (err) {
    const attempts = job.opts.attempts ?? 1;
    const final = job.attemptsMade + 1 >= attempts;
    deps.logger.warn(
      { jobId: job.id, attempt: job.attemptsMade + 1, attempts, err: err instanceof Error ? err.message : String(err) },
      final ? 'email failed (giving up)' : 'email failed (will retry)',
    );
    if (final && track) await deps.markInvite(track, 'FAILED');
    throw err;
  }
}
