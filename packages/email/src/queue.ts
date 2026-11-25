import type { EmailMessage } from './provider';

/** BullMQ queue for outgoing email; processed by apps/worker. */
export const EMAIL_QUEUE = 'email';
export const SEND_EMAIL_JOB = 'send-email';

/** Optional delivery tracking: the worker sets the invite's `emailStatus` to SENT / FAILED. */
export interface InviteEmailTracking {
  kind: 'invite';
  shopId: string;
  invitationId: string;
  /** Only the send this job belongs to updates the status (a later resend supersedes it). */
  sendCount: number;
}

export interface SendEmailJobData {
  message: EmailMessage;
  track?: InviteEmailTracking;
}

/**
 * 3 attempts with exponential backoff (5s, 10s). Jobs carry the invite link, so completed jobs are removed at once
 * and failed ones after a day.
 */
export const EMAIL_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 60 * 60 },
};
