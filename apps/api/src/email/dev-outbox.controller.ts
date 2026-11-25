import { Controller, Get, Inject, Param } from '@nestjs/common';
import { listOutbox, type OutboxItem, readOutboxItem } from '@repairos/email';
import { Public } from '../auth/auth-context';
import { notFound } from '../common/errors';
import { CONFIG, type AppConfig, isDevNodeEnv } from '../config';

/**
 * Dev-only outbox (D6), read by the web app's /dev/outbox page and E2E tests. Not in contracts:
 *   GET /api/dev/outbox      → { items: OutboxItem[] } newest first, at most 50
 *   GET /api/dev/outbox/:id  → OutboxItem
 * M2: 404 unless all three hold: DEV_OUTBOX=1, the email provider is the file outbox (no RESEND_API_KEY), and
 * NODE_ENV is development or test. A missing or mistyped setting fails closed.
 */
export function isDevOutboxEnabled(config: Pick<AppConfig, 'devOutbox' | 'nodeEnv' | 'email'>): boolean {
  return config.devOutbox && config.email.provider === 'outbox' && isDevNodeEnv(config.nodeEnv);
}

@Controller('dev/outbox')
export class DevOutboxController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private assertEnabled(): void {
    if (!isDevOutboxEnabled(this.config)) throw notFound();
  }

  @Public()
  @Get()
  async list(): Promise<{ items: OutboxItem[] }> {
    this.assertEnabled();
    return { items: await listOutbox(this.config.email.outboxDir, 50) };
  }

  @Public()
  @Get(':id')
  async get(@Param('id') id: string): Promise<OutboxItem> {
    this.assertEnabled();
    const item = await readOutboxItem(this.config.email.outboxDir, id);
    if (!item) throw notFound();
    return item;
  }
}
