import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext, type RequestContext } from './request-context';

/** Header clients may set to supply their own correlation id. */
const REQUEST_ID_HEADER = 'x-request-id';
/** W3C trace context, when an upstream proxy or client provides one. */
const TRACEPARENT_HEADER = 'traceparent';

/**
 * Establishes the per-request context for the whole downstream call graph.
 *
 * Runs before guards, so identity fields are filled in later via
 * `enrichContext` once the JWT or API key has actually been verified.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header(REQUEST_ID_HEADER);
    // Accept a client-supplied id only if it looks sane — an unbounded header
    // would otherwise end up in every log line and in the response.
    const requestId = inbound && /^[\w.:-]{1,128}$/.test(inbound) ? inbound : randomUUID();

    const context: RequestContext = {
      requestId,
      traceId: this.parseTraceId(req.header(TRACEPARENT_HEADER)),
    };

    // Echo the correlation id so a client can quote it in a support request.
    res.setHeader(REQUEST_ID_HEADER, requestId);

    runWithContext(context, () => next());
  }

  /** Extracts the 32-hex trace-id from a W3C `traceparent` header. */
  private parseTraceId(traceparent?: string): string | undefined {
    if (!traceparent) return undefined;
    const parts = traceparent.split('-');
    // version-traceid-spanid-flags
    if (parts.length < 3) return undefined;
    const traceId = parts[1];
    return /^[0-9a-f]{32}$/.test(traceId) ? traceId : undefined;
  }
}
