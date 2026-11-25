import { Controller, Get, Inject, Param } from '@nestjs/common';
import { listOutbox, type OutboxItem, readOutboxItem } from '@repairos/email';
import { Public } from '../auth/auth-context';
import { notFound } from '../common/errors';
import { CONFIG, type AppConfig } from '../config';

/**
 * Dev-only outbox (D6), read by the web app's /dev/outbox page and E2E tests. Not in contracts:
 *   GET /api/dev/outbox      → { items: OutboxItem[] } newest first, at most 50
 *   GET /api/dev/outbox/:id  → OutboxItem
 * 404 unless NODE_ENV is development or test.
 */
@Controller('dev/outbox')
export class DevOutboxController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private assertEnabled(): void {
    if (this.config.nodeEnv !== 'development' && this.config.nodeEnv !== 'test') throw notFound();
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
