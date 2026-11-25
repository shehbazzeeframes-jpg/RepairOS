import { Controller, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import {
  CreateTicketStatusInput,
  ReorderTicketStatusesInput,
  type TicketSettings,
  type TicketStatus,
  type TicketStatusListResponse,
  UpdateTicketSettingsInput,
  UpdateTicketStatusInput,
} from '@repairos/contracts';
import { type Actor, CurrentActor, RequirePermission } from '../auth/auth-context';
import { ZodBody } from '../common/zod';
import { TicketConfigService } from './ticket-config.service';

@Controller('ticket-statuses')
export class TicketStatusesController {
  constructor(@Inject(TicketConfigService) private readonly config: TicketConfigService) {}

  @RequirePermission('tickets.view')
  @Get()
  list(@CurrentActor() actor: Actor): Promise<TicketStatusListResponse> {
    return this.config.listStatuses(actor);
  }

  @RequirePermission('statuses.manage')
  @Post()
  @HttpCode(201)
  create(@CurrentActor() actor: Actor, @ZodBody(CreateTicketStatusInput) input: CreateTicketStatusInput): Promise<TicketStatus> {
    return this.config.createStatus(actor, input);
  }

  // Declared before ':id' so "order" is never taken for an id.
  @RequirePermission('statuses.manage')
  @Put('order')
  reorder(@CurrentActor() actor: Actor, @ZodBody(ReorderTicketStatusesInput) input: ReorderTicketStatusesInput): Promise<TicketStatusListResponse> {
    return this.config.reorder(actor, input);
  }

  @RequirePermission('statuses.manage')
  @Patch(':id')
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @ZodBody(UpdateTicketStatusInput) input: UpdateTicketStatusInput): Promise<TicketStatus> {
    return this.config.updateStatus(actor, id, input);
  }
}

@Controller('shop/ticket-settings')
export class TicketSettingsController {
  constructor(@Inject(TicketConfigService) private readonly config: TicketConfigService) {}

  @RequirePermission('settings.view')
  @Get()
  get(@CurrentActor() actor: Actor): Promise<TicketSettings> {
    return this.config.getSettings(actor);
  }

  @RequirePermission('settings.manage')
  @Patch()
  update(@CurrentActor() actor: Actor, @ZodBody(UpdateTicketSettingsInput) input: UpdateTicketSettingsInput): Promise<TicketSettings> {
    return this.config.updateSettings(actor, input);
  }
}
