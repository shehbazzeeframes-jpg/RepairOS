import { Controller, Get, Inject, Param } from '@nestjs/common';
import { type AuditEventDetail, AuditEventListQuery, type AuditEventListResponse } from '@repairos/contracts';
import { type Actor, CurrentActor, RequirePermission } from '../auth/auth-context';
import { ZodQuery } from '../common/zod';
import { AuditService } from './audit.service';

@Controller('audit-events')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @RequirePermission('audit.view')
  @Get()
  list(@CurrentActor() actor: Actor, @ZodQuery(AuditEventListQuery) query: AuditEventListQuery): Promise<AuditEventListResponse> {
    return this.audit.list(actor, query);
  }

  @RequirePermission('audit.view')
  @Get(':id')
  detail(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<AuditEventDetail> {
    return this.audit.detail(actor, id);
  }
}
