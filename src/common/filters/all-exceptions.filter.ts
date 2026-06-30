import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

/** Normalizes every thrown error into a stable JSON error envelope. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpCtx = host.switchToHttp();
    const res = httpCtx.getResponse<Response>();
    const req = httpCtx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal_error';
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        code = this.codeFromStatus(status);
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        code = (b.code as string) ?? this.codeFromStatus(status);
        message = (b.message as string) ?? message;
        details = b.details ?? (Array.isArray(b.message) ? b.message : undefined);
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      ({ status, code, message } = this.mapPrismaError(exception));
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(exception.message, exception.stack);
    }

    if (status >= 500) {
      this.logger.error(`${req.method} ${req.url} -> ${status} ${message}`);
    }

    res.status(status).json({
      error: { code, message, details },
      requestId: req.header('x-request-id') ?? undefined,
    });
  }

  private mapPrismaError(e: Prisma.PrismaClientKnownRequestError) {
    switch (e.code) {
      case 'P2002':
        return { status: HttpStatus.CONFLICT, code: 'conflict', message: 'Resource already exists' };
      case 'P2025':
        return { status: HttpStatus.NOT_FOUND, code: 'not_found', message: 'Resource not found' };
      case 'P2003':
        return { status: HttpStatus.BAD_REQUEST, code: 'fk_violation', message: 'Related resource missing' };
      default:
        return { status: HttpStatus.BAD_REQUEST, code: 'db_error', message: 'Database request error' };
    }
  }

  private codeFromStatus(status: number): string {
    const map: Record<number, string> = {
      400: 'bad_request',
      401: 'unauthorized',
      403: 'forbidden',
      404: 'not_found',
      409: 'conflict',
      429: 'rate_limited',
    };
    return map[status] ?? 'error';
  }
}
