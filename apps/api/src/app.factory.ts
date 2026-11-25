import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { AppModule } from './app.module';
import { AUTH, type Auth } from './auth/auth';
import { authRateLimits, invitePreviewRateLimit } from './auth/rate-limit';
import { ApiErrorFilter, toApiError } from './common/api-error.filter';
import { jsonBody } from './common/json-body';
import type { AppConfig } from './config';

/** Client-supplied request ids are kept only if short and safe to log. */
const REQUEST_ID = /^[\w-]{1,64}$/;

export function createLogger(config: AppConfig) {
  const pretty = config.nodeEnv === 'development' && process.stdout.isTTY;
  return pino({
    level: config.logLevel,
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}

/**
 * Builds and initialises the Nest app (used by main.ts and the tests).
 * Middleware order: pino-http → helmet → CORS → auth rate limits → Better Auth
 * → JSON body parser → Nest routes → error handler.
 */
export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const logger = createLogger(config);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, logger), {
    bodyParser: false, // Better Auth reads the raw request; JSON parsing is added after it.
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.flushLogs();

  const server = app.getHttpAdapter().getInstance() as express.Express;
  server.disable('x-powered-by');
  // Which proxies may set X-Forwarded-For (TRUST_PROXY; default loopback = the web app's local proxy).
  server.set('trust proxy', config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const header = req.headers['x-request-id'];
        const id = typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );
  app.use(helmet());
  app.enableCors({ origin: config.appUrl, credentials: true });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiErrorFilter());

  app.use(authRateLimits(config.authRateLimitMax, config.appUrl));
  app.use(invitePreviewRateLimit(config.invitePreviewRateLimit));

  const auth = app.get<Auth>(AUTH);
  server.all('/api/auth/{*path}', toNodeHandler(auth));

  app.use(jsonBody('1mb'));

  await app.init();

  // Errors raised outside Nest's router (e.g. body-parser) still get the ApiError shape.
  server.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const body = toApiError(err);
    res.status(body.statusCode).json(body);
  });

  return app;
}
