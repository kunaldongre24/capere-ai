import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode, type ErrorCodeValue } from './api-response';

/**
 * Domain exception carrying a stable machine-readable code.
 *
 * Thrown by services (which hold the business logic) and translated into the
 * standard envelope by the global exception filter. Controllers never build
 * these by hand — they translate framework or validation failures.
 */
export class AppException extends HttpException {
  readonly code: ErrorCodeValue;
  readonly details?: unknown;

  constructor(code: ErrorCodeValue, message: string, status: HttpStatus, details?: unknown) {
    super({ code, message, details }, status);
    this.code = code;
    this.details = details;
  }

  // --- Common shapes, so call sites read as intent -------------------------

  static notFound(code: ErrorCodeValue, message: string, details?: unknown): AppException {
    return new AppException(code, message, HttpStatus.NOT_FOUND, details);
  }

  static conflict(code: ErrorCodeValue, message: string, details?: unknown): AppException {
    return new AppException(code, message, HttpStatus.CONFLICT, details);
  }

  static forbidden(code: ErrorCodeValue, message: string, details?: unknown): AppException {
    return new AppException(code, message, HttpStatus.FORBIDDEN, details);
  }

  static unauthorized(code: ErrorCodeValue, message: string, details?: unknown): AppException {
    return new AppException(code, message, HttpStatus.UNAUTHORIZED, details);
  }

  static badRequest(code: ErrorCodeValue, message: string, details?: unknown): AppException {
    return new AppException(code, message, HttpStatus.BAD_REQUEST, details);
  }

  static tooManyRequests(message: string, details?: unknown): AppException {
    return new AppException(ErrorCode.RATE_LIMITED, message, HttpStatus.TOO_MANY_REQUESTS, details);
  }

  static internal(message: string, details?: unknown): AppException {
    return new AppException(
      ErrorCode.INTERNAL_ERROR,
      message,
      HttpStatus.INTERNAL_SERVER_ERROR,
      details,
    );
  }

  static serviceUnavailable(
    code: ErrorCodeValue,
    message: string,
    details?: unknown,
  ): AppException {
    return new AppException(code, message, HttpStatus.SERVICE_UNAVAILABLE, details);
  }
}
