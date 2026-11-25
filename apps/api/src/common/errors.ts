import { HttpException } from '@nestjs/common';
import type { ApiError, ApiErrorCode } from '@repairos/contracts';

/** Every code, with its HTTP status, is listed in contracts (`ApiErrorCode`, `API_ERROR_STATUS`). */
export type { ApiErrorCode };

export type ApiIssue = NonNullable<ApiError['issues']>[number];

/** Throw this to control the exact ApiError body. */
export class ApiException extends HttpException {
  constructor(
    statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly issues?: ApiIssue[],
  ) {
    super({ statusCode, code, message, ...(issues ? { issues } : {}) } satisfies ApiError, statusCode);
  }
}

export const validationFailed = (issues: ApiIssue[], message = 'Validation failed') =>
  new ApiException(400, 'VALIDATION_FAILED', message, issues);

export const forbidden = (message = 'You do not have access to this resource') =>
  new ApiException(403, 'FORBIDDEN', message);

export const STATUS_TO_CODE: Record<number, ApiErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION_FAILED',
  415: 'VALIDATION_FAILED',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
};
