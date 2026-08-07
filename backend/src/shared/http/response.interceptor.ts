import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { getRequestId } from '../context/request-context';
import type { ResponseMeta, SuccessResponse } from './api-response';
import { RAW_RESPONSE_KEY } from './raw-response.decorator';

/** Shape a handler may return to supply pagination metadata alongside data. */
interface PaginatedPayload<T> {
  data: T;
  pagination: NonNullable<ResponseMeta['pagination']>;
}

function isPaginated<T>(value: unknown): value is PaginatedPayload<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'pagination' in value &&
    typeof (value as PaginatedPayload<T>).pagination === 'object'
  );
}

/**
 * Wraps every successful response in the standard envelope.
 *
 * Handlers return plain domain objects; this is the single place the transport
 * shape is applied, so no controller hand-rolls it and none can drift.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, SuccessResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<SuccessResponse<T> | T> {
    const isRaw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isRaw) {
      return next.handle();
    }

    return next.handle().pipe(
      map((payload): SuccessResponse<T> => {
        const meta: ResponseMeta = {
          requestId: getRequestId() ?? 'unknown',
          timestamp: new Date().toISOString(),
        };

        // A handler can return { data, pagination } to populate meta.pagination
        // without inventing its own envelope.
        if (isPaginated<T>(payload)) {
          return { data: payload.data, meta: { ...meta, pagination: payload.pagination } };
        }

        return { data: payload, meta };
      }),
    );
  }
}
