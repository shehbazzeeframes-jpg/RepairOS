import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import {
  type BusinessHoursResponse,
  CreateTaxRateInput,
  type ShopProfile,
  type ShopSettingsResponse,
  type TaxRate,
  TaxRateListQuery,
  type TaxRateListResponse,
  type TaxSettings,
  UpdateBusinessHoursInput,
  UpdateTaxRateInput,
  UpdateTaxSettingsInput,
} from '@repairos/contracts';
import { type Actor, CurrentActor, RequirePermission } from '../auth/auth-context';
import { ZodBody, ZodQuery } from '../common/zod';
import { ShopSettingsService } from './shop-settings.service';

/** Shop settings (story §4): profile, tax settings, tax rates, business hours. */
@Controller('shop')
export class ShopSettingsController {
  constructor(@Inject(ShopSettingsService) private readonly settings: ShopSettingsService) {}

  @RequirePermission('settings.view')
  @Get()
  get(@CurrentActor() actor: Actor): Promise<ShopSettingsResponse> {
    return this.settings.getSettings(actor);
  }

  /** Body is validated with `shopProfileSchema(shop.country)` in the service (needs the shop's country). */
  @RequirePermission('settings.manage')
  @Patch()
  update(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<ShopProfile> {
    return this.settings.updateProfile(actor, body);
  }

  @RequirePermission('tax.manage')
  @Patch('tax-settings')
  updateTaxSettings(@CurrentActor() actor: Actor, @ZodBody(UpdateTaxSettingsInput) input: UpdateTaxSettingsInput): Promise<TaxSettings> {
    return this.settings.updateTaxSettings(actor, input);
  }

  @RequirePermission('settings.manage')
  @Put('hours')
  updateHours(@CurrentActor() actor: Actor, @ZodBody(UpdateBusinessHoursInput) input: UpdateBusinessHoursInput): Promise<BusinessHoursResponse> {
    return this.settings.updateHours(actor, input);
  }

  @RequirePermission('settings.view')
  @Get('tax-rates')
  listTaxRates(@CurrentActor() actor: Actor, @ZodQuery(TaxRateListQuery) query: TaxRateListQuery): Promise<TaxRateListResponse> {
    return this.settings.listTaxRates(actor, query.includeArchived);
  }

  @RequirePermission('tax.manage')
  @Post('tax-rates')
  @HttpCode(201)
  createTaxRate(@CurrentActor() actor: Actor, @ZodBody(CreateTaxRateInput) input: CreateTaxRateInput): Promise<TaxRate> {
    return this.settings.createTaxRate(actor, input);
  }

  @RequirePermission('tax.manage')
  @Patch('tax-rates/:id')
  updateTaxRate(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @ZodBody(UpdateTaxRateInput) input: UpdateTaxRateInput,
  ): Promise<TaxRate> {
    return this.settings.updateTaxRate(actor, id, input);
  }

  @RequirePermission('tax.manage')
  @Post('tax-rates/:id/archive')
  @HttpCode(200)
  archive(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<TaxRate> {
    return this.settings.archiveTaxRate(actor, id);
  }

  @RequirePermission('tax.manage')
  @Post('tax-rates/:id/restore')
  @HttpCode(200)
  restore(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<TaxRate> {
    return this.settings.restoreTaxRate(actor, id);
  }
}
