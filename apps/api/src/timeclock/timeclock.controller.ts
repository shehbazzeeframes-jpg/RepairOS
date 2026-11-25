import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import {
  CreateTimeEntryInput,
  DeleteTimeEntryInput,
  type TimeclockStatus,
  type TimeEntry,
  TimesheetQuery,
  type TimesheetResponse,
  UpdateTimeEntryInput,
} from '@repairos/contracts';
import type { Request, Response } from 'express';
import { type Actor, CurrentActor, RequirePermission } from '../auth/auth-context';
import { isPrefetchRequest } from '../common/prefetch';
import { ZodBody, ZodQuery, ZodValidationPipe } from '../common/zod';
import { TimeclockService } from './timeclock.service';

/** Self clock in/out (story §5 C1). Server time only; scope is the active shop. */
@Controller('timeclock')
export class TimeclockController {
  constructor(@Inject(TimeclockService) private readonly timeclock: TimeclockService) {}

  @RequirePermission('timeclock.self')
  @Get('me')
  me(@CurrentActor() actor: Actor): Promise<TimeclockStatus> {
    return this.timeclock.me(actor);
  }

  @RequirePermission('timeclock.self')
  @Post('clock-in')
  @HttpCode(200)
  clockIn(@CurrentActor() actor: Actor): Promise<TimeclockStatus> {
    return this.timeclock.clockIn(actor);
  }

  @RequirePermission('timeclock.self')
  @Post('clock-out')
  @HttpCode(200)
  clockOut(@CurrentActor() actor: Actor): Promise<TimeclockStatus> {
    return this.timeclock.clockOut(actor);
  }
}

/** Timesheets and CSV export (story §5 C2, C4). */
@Controller('timesheets')
export class TimesheetsController {
  constructor(@Inject(TimeclockService) private readonly timeclock: TimeclockService) {}

  @RequirePermission('timesheet.view')
  @Get()
  get(@CurrentActor() actor: Actor, @ZodQuery(TimesheetQuery) query: TimesheetQuery): Promise<TimesheetResponse> {
    return this.timeclock.timesheet(actor, query);
  }

  @RequirePermission('timesheet.export')
  @Get('export.csv')
  async export(@CurrentActor() actor: Actor, @Query() rawQuery: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    // BUG-02: the export writes a `timesheet.exported` audit event, so a prefetch (Next <Link>, browser
    // speculation) must not run it: 204 with no body, before the query is even validated.
    if (isPrefetchRequest(req.headers)) {
      res.status(204).set('Cache-Control', 'no-store').end();
      return;
    }
    const query = new ZodValidationPipe(TimesheetQuery).transform(rawQuery);
    const { filename, body } = await this.timeclock.exportCsv(actor, query);
    res
      .status(200)
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${filename}"`)
      .set('Cache-Control', 'no-store')
      .send(body);
  }
}

/** Manual corrections (story §5 C3, D5). */
@Controller('time-entries')
export class TimeEntriesController {
  constructor(@Inject(TimeclockService) private readonly timeclock: TimeclockService) {}

  @RequirePermission('timesheet.edit')
  @Post()
  @HttpCode(201)
  create(@CurrentActor() actor: Actor, @ZodBody(CreateTimeEntryInput) input: CreateTimeEntryInput): Promise<TimeEntry> {
    return this.timeclock.createEntry(actor, input);
  }

  @RequirePermission('timesheet.edit')
  @Patch(':id')
  update(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @ZodBody(UpdateTimeEntryInput) input: UpdateTimeEntryInput,
  ): Promise<TimeEntry> {
    return this.timeclock.updateEntry(actor, id, input);
  }

  @RequirePermission('timesheet.edit')
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @ZodBody(DeleteTimeEntryInput) input: DeleteTimeEntryInput,
  ): Promise<void> {
    await this.timeclock.deleteEntry(actor, id, input.reason);
  }
}
