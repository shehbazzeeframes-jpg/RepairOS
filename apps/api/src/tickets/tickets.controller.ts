import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import {
  type AssigneesResponse,
  AssignTicketInput,
  CancelTicketInput,
  ChangeTicketStatusInput,
  type CheckInContext,
  CreateTicketNoteInput,
  type DashboardSummary,
  type PasscodeReveal,
  ReopenTicketInput,
  type TicketCounts,
  type TicketDetail,
  TicketListQuery,
  type TicketListResponse,
  type TicketNote,
  TimelineQuery,
  type TimelineResponse,
  UpdateTicketInput,
  UpdateTicketNoteInput,
} from '@repairos/contracts';
import type { Response } from 'express';
import { type Actor, CurrentActor, RequirePermission } from '../auth/auth-context';
import { ZodBody, ZodQuery } from '../common/zod';
import { TicketConfigService } from '../ticket-config/ticket-config.service';
import { TicketQueryService } from './ticket-query.service';
import { TicketsService, type UpdateTicketData } from './tickets.service';

/**
 * Tickets (story §5). Fine-grained rules (customers.manage for nested creates and device/customer changes, the
 * close-lifecycle permission per `canTransition`) are checked in the service.
 */
@Controller('tickets')
export class TicketsController {
  constructor(
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(TicketQueryService) private readonly query: TicketQueryService,
    @Inject(TicketConfigService) private readonly config: TicketConfigService,
  ) {}

  @RequirePermission('tickets.view')
  @Get()
  list(@CurrentActor() actor: Actor, @ZodQuery(TicketListQuery) q: TicketListQuery): Promise<TicketListResponse> {
    return this.query.list(actor, q);
  }

  /** Body parsed with `createTicketSchema(shop.country)` in the service. 201, or 200 for an idempotent repeat. */
  @RequirePermission('tickets.create')
  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TicketDetail> {
    const { ticket, created } = await this.tickets.create(actor, body, key);
    res.status(created ? 201 : 200);
    return ticket;
  }

  @RequirePermission('tickets.view')
  @Get('counts')
  counts(@CurrentActor() actor: Actor): Promise<TicketCounts> {
    return this.query.counts(actor);
  }

  @RequirePermission('tickets.create')
  @Get('check-in-context')
  checkInContext(@CurrentActor() actor: Actor): Promise<CheckInContext> {
    return this.config.checkInContext(actor);
  }

  @RequirePermission('tickets.view')
  @Get(':id')
  detail(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<TicketDetail> {
    return this.tickets.detail(actor, id);
  }

  @RequirePermission('tickets.edit')
  @Patch(':id')
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @ZodBody(UpdateTicketInput) input: UpdateTicketData): Promise<TicketDetail> {
    return this.tickets.update(actor, id, input);
  }

  /** `tickets.edit` is the floor; moving into a closed status (Collect) needs `tickets.cancel` (canTransition). */
  @RequirePermission('tickets.edit')
  @Post(':id/status')
  @HttpCode(200)
  status(@CurrentActor() actor: Actor, @Param('id') id: string, @ZodBody(ChangeTicketStatusInput) input: ChangeTicketStatusInput): Promise<TicketDetail> {
    return this.tickets.changeStatus(actor, id, input);
  }

  @RequirePermission('tickets.edit')
  @Post(':id/assign')
  @HttpCode(200)
  assign(@CurrentActor() actor: Actor, @Param('id') id: string, @ZodBody(AssignTicketInput) input: AssignTicketInput): Promise<TicketDetail> {
    return this.tickets.assign(actor, id, input);
  }

  @RequirePermission('tickets.cancel')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentActor() actor: Actor, @Param('id') id: string, @ZodBody(CancelTicketInput) input: CancelTicketInput): Promise<TicketDetail> {
    return this.tickets.cancel(actor, id, input);
  }

  @RequirePermission('tickets.cancel')
  @Post(':id/reopen')
  @HttpCode(200)
  reopen(@CurrentActor() actor: Actor, @Param('id') id: string, @ZodBody(ReopenTicketInput) input: ReopenTicketInput): Promise<TicketDetail> {
    return this.tickets.reopen(actor, id, input);
  }

  @RequirePermission('tickets.view')
  @Get(':id/timeline')
  timeline(@CurrentActor() actor: Actor, @Param('id') id: string, @ZodQuery(TimelineQuery) q: TimelineQuery): Promise<TimelineResponse> {
    return this.query.timeline(actor, id, q);
  }

  @RequirePermission('tickets.edit')
  @Post(':id/notes')
  @HttpCode(201)
  addNote(@CurrentActor() actor: Actor, @Param('id') id: string, @ZodBody(CreateTicketNoteInput) input: CreateTicketNoteInput): Promise<TicketNote> {
    return this.tickets.addNote(actor, id, input);
  }

  @RequirePermission('tickets.edit')
  @Patch(':id/notes/:noteId')
  editNote(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Param('noteId') noteId: string,
    @ZodBody(UpdateTicketNoteInput) input: UpdateTicketNoteInput,
  ): Promise<TicketNote> {
    return this.tickets.editNote(actor, id, noteId, input);
  }

  /** A15: POST only, `Cache-Control: no-store`, audited, rate limited. */
  @RequirePermission('tickets.view_passcode')
  @Post(':id/passcode/reveal')
  @HttpCode(200)
  async reveal(@CurrentActor() actor: Actor, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<PasscodeReveal> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return this.tickets.revealPasscode(actor, id);
  }
}

@Controller()
export class TicketExtrasController {
  constructor(@Inject(TicketQueryService) private readonly query: TicketQueryService) {}

  @RequirePermission('tickets.view')
  @Get('assignees')
  assignees(@CurrentActor() actor: Actor): Promise<AssigneesResponse> {
    return this.query.assignees(actor);
  }

  @RequirePermission('tickets.view')
  @Get('dashboard')
  dashboard(@CurrentActor() actor: Actor): Promise<DashboardSummary> {
    return this.query.dashboard(actor);
  }
}
