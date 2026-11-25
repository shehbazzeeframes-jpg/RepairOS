import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { ApiError } from '@repairos/contracts';
import type { Response } from 'express';
import { ApiException, STATUS_TO_CODE } from './errors';
import { redactSecrets } from './log-redact';

interface PrismaLikeError {
  name: string;
  code: string;
}
const isPrismaKnownError = (e: unknown): e is PrismaLikeError =>
  e instanceof Error && e.name === 'PrismaClientKnownRequestError' && typeof (e as { code?: unknown }).code === 'string';

/**
 * Postgres 42501 (insufficient_privilege): an RLS policy or a revoked grant blocked the query.
 * Model queries surface it as PrismaClientUnknownRequestError (code only in the message),
 * raw queries as P2010 with meta.code.
 */
export function isPrivilegeViolation(e: unknown): boolean {
  if (!(e instanceof Error) || !e.name.startsWith('PrismaClient')) return false;
  const meta = (e as { meta?: { code?: unknown } }).meta;
  return meta?.code === '42501' || /code: "42501"/.test(e.message);
}

/** Fixed, parser-independent messages: never echo body-parser internals. */
const BODY_PARSER_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'Malformed JSON body',
  'entity.too.large': 'Request body too large',
  'encoding.unsupported': 'Unsupported request body encoding',
  'charset.unsupported': 'Unsupported request body charset',
  'request.aborted': 'Request body was not received completely',
};

/** body-parser errors carry `type` and `status`. */
const isBodyParserError = (e: unknown): e is Error & { type: string; status: number } =>
  e instanceof Error && typeof (e as { type?: unknown }).type === 'string' && typeof (e as { status?: unknown }).status === 'number';

/** Maps every error to the contracts' ApiError shape. */
export function toApiError(exception: unknown): ApiError {
  if (exception instanceof ApiException) return exception.getResponse() as ApiError;

  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    const res = exception.getResponse();
    const raw = typeof res === 'string' ? res : (res as { message?: unknown }).message;
    const message = Array.isArray(raw) ? raw.join('; ') : typeof raw === 'string' ? raw : exception.message;
    return { statusCode, code: STATUS_TO_CODE[statusCode] ?? (statusCode >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED'), message };
  }

  if (isBodyParserError(exception)) {
    const message = BODY_PARSER_MESSAGES[exception.type] ?? 'Invalid request body';
    return { statusCode: exception.status, code: STATUS_TO_CODE[exception.status] ?? 'VALIDATION_FAILED', message };
  }

  // Treated as "not found" so the response never confirms another shop's data exists.
  if (isPrivilegeViolation(exception)) return { statusCode: 404, code: 'NOT_FOUND', message: 'Not found' };

  if (isPrismaKnownError(exception)) {
    if (exception.code === 'P2002') return { statusCode: 409, code: 'CONFLICT', message: 'Already exists' };
    if (exception.code === 'P2025') return { statusCode: 404, code: 'NOT_FOUND', message: 'Not found' };
  }

  return { statusCode: 500, code: 'INTERNAL', message: 'Something went wrong' };
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const body = toApiError(exception);
    if (isPrivilegeViolation(exception)) {
      const req = host.switchToHttp().getRequest<{ method?: string; url?: string; auth?: { user?: { id?: string }; activeShop?: unknown } }>();
      this.logger.warn(
        `SECURITY: database privilege/RLS violation on ${req.method} ${redactSecrets(req.url ?? '')} user=${req.auth?.user?.id ?? 'anonymous'} ` +
          `activeShop=${JSON.stringify(req.auth?.activeShop ?? null)}: ${exception instanceof Error ? exception.message.split('\n').pop() : ''}`,
      );
    } else if (body.statusCode >= 500) {
      this.logger.error(redactSecrets(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)));
    }
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    res.status(body.statusCode).json(body);
  }
}
