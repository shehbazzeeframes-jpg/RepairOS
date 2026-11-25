import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import {
  AppendConsentsInput,
  type ConsentHistoryResponse,
  type CustomerDetail,
  CustomerListQuery,
  type CustomerListResponse,
  CustomerTagsQuery,
  type CustomerTagsResponse,
  DuplicateCheckQuery,
  type DuplicateCheckResponse,
  EraseCustomerInput,
  type EraseCustomerResponse,
} from '@repairos/contracts';
import type { Response } from 'express';
import { type Actor, CurrentActor, RequirePermission } from '../auth/auth-context';
import { ZodBody, ZodQuery } from '../common/zod';
import { CustomersService } from './customers.service';

/** Customers (story §1). Bodies of create/update are parsed with the country-aware schemas in the service. */
@Controller('customers')
export class CustomersController {
  constructor(@Inject(CustomersService) private readonly customers: CustomersService) {}

  @RequirePermission('customers.view')
  @Get()
  list(@CurrentActor() actor: Actor, @ZodQuery(CustomerListQuery) q: CustomerListQuery): Promise<CustomerListResponse> {
    return this.customers.list(actor, q);
  }

  @RequirePermission('customers.view')
  @Get('duplicates')
  duplicates(@CurrentActor() actor: Actor, @ZodQuery(DuplicateCheckQuery) q: DuplicateCheckQuery): Promise<DuplicateCheckResponse> {
    return this.customers.duplicates(actor, q);
  }

  @RequirePermission('customers.view')
  @Get('tags')
  tags(@CurrentActor() actor: Actor, @ZodQuery(CustomerTagsQuery) q: CustomerTagsQuery): Promise<CustomerTagsResponse> {
    return this.customers.tags(actor, q.q);
  }

  @RequirePermission('customers.manage')
  @Post()
  @HttpCode(201)
  create(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<CustomerDetail> {
    return this.customers.create(actor, body);
  }

  @RequirePermission('customers.view')
  @Get(':id')
  detail(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<CustomerDetail> {
    return this.customers.detail(actor, id);
  }

  @RequirePermission('customers.manage')
  @Patch(':id')
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown): Promise<CustomerDetail> {
    return this.customers.update(actor, id, body);
  }

  @RequirePermission('customers.view')
  @Get(':id/consents')
  consents(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<ConsentHistoryResponse> {
    return this.customers.consentHistory(actor, id);
  }

  @RequirePermission('customers.manage')
  @Post(':id/consents')
  @HttpCode(200)
  appendConsents(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @ZodBody(AppendConsentsInput) input: AppendConsentsInput,
  ): Promise<CustomerDetail> {
    return this.customers.appendConsents(actor, id, input);
  }

  @RequirePermission('customers.manage')
  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<CustomerDetail> {
    return this.customers.archive(actor, id);
  }

  @RequirePermission('customers.manage')
  @Post(':id/restore')
  @HttpCode(200)
  restore(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<CustomerDetail> {
    return this.customers.restore(actor, id);
  }

  @RequirePermission('customers.export_delete')
  @Get(':id/export')
  async export(@CurrentActor() actor: Actor, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    const { filename, body } = await this.customers.export(actor, id);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return body;
  }

  @RequirePermission('customers.export_delete')
  @Post(':id/erase')
  @HttpCode(200)
  erase(@CurrentActor() actor: Actor, @Param('id') id: string, @ZodBody(EraseCustomerInput) _input: EraseCustomerInput): Promise<EraseCustomerResponse> {
    return this.customers.erase(actor, id);
  }
}
