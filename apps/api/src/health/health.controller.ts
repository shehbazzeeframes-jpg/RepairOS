import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@repairos/contracts';
import { Public } from '../auth/auth-context';
import { CONFIG, type AppConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  async get(): Promise<HealthResponse> {
    let db: 'up' | 'down' = 'up';
    try {
      await this.prisma.base.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    return { status: 'ok', db, version: this.config.version };
  }
}
