import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { getRequestId } from '../context/request-context';
import { ErrorCode, type ErrorResponse, type ErrorCodeValue } from './api-response';
import { AppException } from './app-exception';

/**
 * Global exception filter — the single exit path for every failure.
 *
 * Two responsibilities:
 *
 * 1. **Uniform shape.** Everything becomes `{ error: { code, message, details }, meta }`
 *    so clients never have to guess at the failure format.
 *
 * 2. **Not leaking internals.** An unexpected exception (a Postgres error, a
 *    TypeError) is logged in full server-side but returned to the client as a
 *    generic INTERNAL_ERROR. Database errors in particular can carry table and
 *    column names, constraint definitions, and occasionally row values — none
 *    of which belongs in an HTTP response, especially a multi-tenant one.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const { status, code, message, details, isUnexpected } = this.normalize(exception);

    if (isUnexpected) {
      // Full detail server-side: this is the only place it exists.
      this.logger.error(
        `Unhandled exception: ${exception instanceof Error ? exception.message : String(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${code}: ${message}`);
    } else {
      this.logger.debug(`${code}: ${message}`);
    }

    const body: ErrorResponse = {
      error: { code, message, ...(details !== undefined ? { details } : {}) },
      meta: {
        requestId: getRequestId() ?? 'unknown',
        timestamp: new Date().toISOString(),
      },
    };

    // If streaming already began (SSE on the chat endpoint), headers are sent
    // and the envelope cannot be written — terminate the stream instead.
    if (response.headersSent) {
      response.end();
      return;
    }

    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    code: ErrorCodeValue;
    message: string;
    details?: unknown;
    isUnexpected: boolean;
  } {
    // Our own domain exceptions already carry everything needed.
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
        isUnexpected: false,
      };
    }

    // Framework exceptions, including ValidationPipe failures.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;

        // class-validator via ValidationPipe: { message: string[], error, statusCode }
        if (Array.isArray(record.message)) {
          return {
            status,
            code: ErrorCode.VALIDATION_FAILED,
            message: 'Request validation failed',
            details: record.message,
            isUnexpected: false,
          };
        }

        return {
          status,
          code: (record.code as ErrorCodeValue) ?? this.codeForStatus(status),
          message: typeof record.message === 'string' ? record.message : exception.message,
          details: record.details,
          isUnexpected: false,
        };
      }

      return {
        status,
        code: this.codeForStatus(status),
        message: typeof payload === 'string' ? payload : exception.message,
        isUnexpected: false,
      };
    }

    // Anything else is a bug. Log it fully, tell the client nothing specific.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred',
      isUnexpected: true,
    };
  }

  private codeForStatus(status: number): ErrorCodeValue {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.BAD_REQUEST;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.SERVICE_UNAVAILABLE;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}
