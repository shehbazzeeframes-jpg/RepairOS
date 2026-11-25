import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { Logger as PinoLogger } from 'pino';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AUTH, createAuth } from './auth/auth';
import { AuthGuard, PermissionGuard } from './auth/guards';
import { CONFIG, type AppConfig } from './config';
import { DevOutboxController } from './email/dev-outbox.controller';
import { EmailService, emailProviderFactory } from './email/email.service';
import { HealthController } from './health/health.controller';
import { MeController } from './me/me.controller';
import { MeService } from './me/me.service';
import { PrismaService } from './prisma/prisma.service';
import { ShopSettingsController } from './shop-settings/shop-settings.controller';
import { ShopSettingsService } from './shop-settings/shop-settings.service';
import { ShopsController } from './shops/shops.controller';
import { ShopsService } from './shops/shops.service';
import { InvitesController } from './staff/invites.controller';
import { InvitesService } from './staff/invites.service';
import { StaffController } from './staff/staff.controller';
import { StaffService } from './staff/staff.service';
import { TimeclockController, TimeEntriesController, TimesheetsController } from './timeclock/timeclock.controller';
import { TimeclockService } from './timeclock/timeclock.service';

/** Every controller; a test checks each route declares @Public(), @SignedIn() or @RequirePermission(). */
export const CONTROLLERS = [
  HealthController,
  MeController,
  ShopsController,
  ShopSettingsController,
  StaffController,
  InvitesController,
  TimeclockController,
  TimesheetsController,
  TimeEntriesController,
  AuditController,
  DevOutboxController,
];

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger: PinoLogger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // pino-http is mounted by app.factory.ts before the auth handler, so it logs every request;
        // nestjs-pino reuses it (useExisting) for the request-scoped Nest logger.
        LoggerModule.forRoot({ pinoHttp: { logger }, useExisting: true }),
      ],
      controllers: CONTROLLERS,
      providers: [
        { provide: CONFIG, useValue: config },
        PrismaService,
        emailProviderFactory,
        EmailService,
        {
          provide: AUTH,
          inject: [PrismaService, EmailService],
          useFactory: (p: PrismaService, email: EmailService) => createAuth(p.base, config, (message) => email.dispatch(message)),
        },
        MeService,
        ShopsService,
        ShopSettingsService,
        StaffService,
        InvitesService,
        TimeclockService,
        AuditService,
        // Order matters: AuthGuard populates req.auth, PermissionGuard reads it.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
      exports: [CONFIG, PrismaService, AUTH],
    };
  }
}
