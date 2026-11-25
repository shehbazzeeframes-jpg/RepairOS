import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { toApiError } from './api-error.filter';

/**
 * express.json() that answers parse errors itself with a fixed ApiError message.
 * Passing them on would let Nest's router turn the SyntaxError into
 * `new BadRequestException(err.message)`, which leaks parser text to the client.
 */
export function jsonBody(limit: string): RequestHandler {
  const parse = express.json({ limit });
  return (req: Request, res: Response, next: NextFunction) => {
    parse(req, res, (err?: unknown) => {
      if (!err) return next();
      const body = toApiError(err);
      res.status(body.statusCode).json(body);
    });
  };
}
