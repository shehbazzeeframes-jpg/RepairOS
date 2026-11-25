import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { ApiError } from '@repairos/contracts';
import type { Response } from 'express';
import { ApiException, STATUS_TO_CODE } from './errors';

interface PrismaLikeError {
  name: string;
  code: string;
}
const isPrismaKnownError = (e: unknown): e is PrismaLikeError =>
  e instanceof Error && e.name === 'PrismaClientKnownRequestError' && typeof (e as { code?: unknown }).code === 'string';

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
    const message = exception.type === 'entity.parse.failed' ? 'Malformed JSON body' : exception.message;
    return { statusCode: exception.status, code: STATUS_TO_CODE[exception.status] ?? 'VALIDATION_FAILED', message };
  }

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
    if (body.statusCode >= 500) {
      this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    }
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    res.status(body.statusCode).json(body);
  }
}
