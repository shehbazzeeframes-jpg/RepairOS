/** One outgoing email. `html` and `text` are both required (every email has a plain-text alternative). */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface SendResult {
  /** Provider message id (outbox: the file id). */
  id: string;
}

/**
 * Delivery mechanism (Sprint 1 story §8, D6). Adapters: `OutboxEmailProvider` (dev/test, JSON files in
 * `<repo>/.outbox/`) and `ResendEmailProvider` (production, used only when RESEND_API_KEY is set).
 * `send` throws on failure so queue retries can kick in.
 */
export interface EmailProvider {
  readonly name: 'outbox' | 'resend';
  send(message: EmailMessage): Promise<SendResult>;
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}
