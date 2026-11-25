import { Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  CreateDeviceInput,
  type Device,
  type DeviceListResponse,
  DeviceLookupQuery,
  type DeviceLookupResponse,
  ModelSuggestionsQuery,
  type ModelSuggestionsResponse,
  QueryBoolean,
  UpdateDeviceInput,
  type UpdateDeviceInputParsed,
} from '@repairos/contracts';
import { type Actor, CurrentActor, RequirePermission } from '../auth/auth-context';
import { ZodBody, ZodQuery } from '../common/zod';
import { DevicesService } from './devices.service';

const ArchivedQuery = { safeParse: (v: unknown) => {
  const r = QueryBoolean.safeParse((v as { archived?: unknown } | undefined)?.archived);
  return r.success ? { success: true as const, data: r.data } : { success: false as const, error: r.error };
} };

/** Devices (story §2). Passcode reveal lives on the ticket (TicketsController). */
@Controller()
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly devices: DevicesService) {}

  @RequirePermission('customers.view')
  @Get('customers/:customerId/devices')
  list(@CurrentActor() actor: Actor, @Param('customerId') customerId: string, @ZodQuery(ArchivedQuery) archived: boolean): Promise<DeviceListResponse> {
    return this.devices.listForCustomer(actor, customerId, archived);
  }

  @RequirePermission('customers.manage')
  @Post('customers/:customerId/devices')
  @HttpCode(201)
  create(@CurrentActor() actor: Actor, @Param('customerId') customerId: string, @ZodBody(CreateDeviceInput) input: CreateDeviceInput): Promise<Device> {
    return this.devices.create(actor, customerId, input);
  }

  @RequirePermission('customers.view')
  @Get('devices/lookup')
  lookup(@CurrentActor() actor: Actor, @ZodQuery(DeviceLookupQuery) q: DeviceLookupQuery): Promise<DeviceLookupResponse> {
    return this.devices.lookup(actor, q);
  }

  @RequirePermission('customers.view')
  @Get('devices/model-suggestions')
  modelSuggestions(@CurrentActor() actor: Actor, @ZodQuery(ModelSuggestionsQuery) q: ModelSuggestionsQuery): Promise<ModelSuggestionsResponse> {
    return this.devices.modelSuggestions(actor, q);
  }

  @RequirePermission('customers.manage')
  @Patch('devices/:id')
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @ZodBody(UpdateDeviceInput) input: UpdateDeviceInputParsed): Promise<Device> {
    return this.devices.update(actor, id, input);
  }

  @RequirePermission('customers.manage')
  @Post('devices/:id/archive')
  @HttpCode(200)
  archive(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<Device> {
    return this.devices.archive(actor, id);
  }

  @RequirePermission('customers.manage')
  @Post('devices/:id/restore')
  @HttpCode(200)
  restore(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<Device> {
    return this.devices.restore(actor, id);
  }
}
