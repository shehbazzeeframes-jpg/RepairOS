import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { Logger as PinoLogger } from 'pino';
import { AUTH, createAuth } from './auth/auth';
import { AuthGuard, RolesGuard } from './auth/guards';
import { CONFIG, type AppConfig } from './config';
import { HealthController } from './health/health.controller';
import { MeController } from './me/me.controller';
import { MeService } from './me/me.service';
import { PrismaService } from './prisma/prisma.service';
import { ShopsController } from './shops/shops.controller';
import { ShopsService } from './shops/shops.service';

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
      controllers: [HealthController, MeController, ShopsController],
      providers: [
        { provide: CONFIG, useValue: config },
        PrismaService,
        { provide: AUTH, inject: [PrismaService], useFactory: (p: PrismaService) => createAuth(p.base, config) },
        MeService,
        ShopsService,
        // Order matters: AuthGuard populates req.auth, RolesGuard reads it.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
      exports: [CONFIG, PrismaService, AUTH],
    };
  }
}
