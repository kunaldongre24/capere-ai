import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'capere:raw_response';

/**
 * Opts a handler out of the standard `{ data, meta }` envelope.
 *
 * Needed for endpoints whose wire format is fixed by an external contract —
 * specifically `/v1/chat/completions`, which must match the OpenAI schema
 * byte-for-byte because Open WebUI parses it. Wrapping that response would
 * break the client.
 *
 * Use sparingly: every Capere-owned endpoint should keep the envelope.
 */
export const RawResponse = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RAW_RESPONSE_KEY, true);
