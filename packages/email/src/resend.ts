import { EmailSendError, type EmailMessage, type EmailProvider, type SendResult } from './provider';

export interface ResendOptions {
  apiKey: string;
  /** e.g. "RepairOS <no-reply@repairos.app>" */
  from: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Production adapter: Resend's REST API (POST /emails), no SDK. */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend' as const;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: ResendOptions) {
    if (!options.apiKey) throw new Error('ResendEmailProvider: apiKey is required');
    if (!options.from) throw new Error('ResendEmailProvider: from is required');
    this.fetchFn = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '');
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const body: Record<string, unknown> = {
      from: this.options.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
    if (message.replyTo) body.reply_to = message.replyTo;

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new EmailSendError(`Resend request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const payload = (await res.json().catch(() => ({}))) as { id?: unknown; message?: unknown; name?: unknown };
    if (!res.ok) {
      const detail = typeof payload.message === 'string' ? payload.message : res.statusText;
      throw new EmailSendError(`Resend responded ${res.status}: ${detail}`, res.status);
    }
    if (typeof payload.id !== 'string') throw new EmailSendError('Resend response has no id', res.status);
    return { id: payload.id };
  }
}
