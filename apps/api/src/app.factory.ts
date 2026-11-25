import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ApiError } from '@repairos/contracts';
import { toNodeHandler } from 'better-auth/node';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { AppModule } from './app.module';
import { AUTH, type Auth } from './auth/auth';
import { ApiErrorFilter, toApiError } from './common/api-error.filter';
import type { AppConfig } from './config';

/** Auth endpoints that take credentials; rate limited per IP. */
const RATE_LIMITED_AUTH_PATHS = [
  '/api/auth/sign-in',
  '/api/auth/sign-up',
  '/api/auth/request-password-reset',
  '/api/auth/reset-password',
  '/api/auth/change-password',
];

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
 * Middleware order: pino-http → helmet → CORS → auth rate limit → Better Auth (raw body)
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
  // The web app's same-origin proxy runs on the same host; trust its X-Forwarded-For.
  server.set('trust proxy', 'loopback');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
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

  app.use(
    RATE_LIMITED_AUTH_PATHS,
    rateLimit({
      windowMs: 60_000,
      limit: config.authRateLimitMax,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req: Request, res: Response) => {
        const body: ApiError = { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a minute.' };
        res.status(429).json(body);
      },
    }),
  );

  const auth = app.get<Auth>(AUTH);
  server.all('/api/auth/{*path}', toNodeHandler(auth));

  app.use(express.json({ limit: '1mb' }));

  await app.init();

  // Errors raised outside Nest's router (e.g. body-parser) still get the ApiError shape.
  server.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const body = toApiError(err);
    res.status(body.statusCode).json(body);
  });

  return app;
}
