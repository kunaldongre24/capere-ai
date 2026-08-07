import { Body, Controller, Get, Post, Req, Res, Version, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiKeyAuth, SkipOrganization, type AuthenticatedRequest } from '../auth';
import { FeatureFlag, FeatureFlagService } from '../feature-flags';
import { GenerateChatResponseUseCase } from '../intelligence';
import { AppException, ErrorCode, RawResponse } from '../shared/http';
import {
  ChatCompletionRequestDto,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ModelListResponse,
} from './chat.dto';
import { CAPERE_MODELS, ChatMapper } from './chat.mapper';

/**
 * OpenAI-compatible chat endpoint.
 *
 * This is the surface Open WebUI talks to, configured as a custom OpenAI
 * provider (`OPENAI_API_BASE_URL=http://capere-backend:3000/v1`). Speaking the
 * OpenAI protocol provides streaming, history, markdown rendering and model
 * selection without Capere building a chat frontend. Attachment ingestion is a
 * separate RAG API concern and is not advertised by this endpoint.
 *
 * Three deliberate deviations from Capere's own API conventions, all forced by
 * the external contract:
 *
 *   1. `VERSION_NEUTRAL` and excluded from the `/api` prefix — the path
 *      `/v1/chat/completions` is fixed by the OpenAI schema.
 *   2. `@RawResponse()` — the `{ data, meta }` envelope would make responses
 *      unparseable to the client.
 *   3. `@ApiKeyAuth()` — Open WebUI authenticates with a Capere-issued key, not
 *      a Supabase user JWT.
 */
@ApiExcludeController()
@Controller({ path: 'v1', version: VERSION_NEUTRAL })
export class ChatController {
  constructor(
    private readonly intelligence: GenerateChatResponseUseCase,
    private readonly mapper: ChatMapper,
    private readonly flags: FeatureFlagService,
  ) {}

  /** Model list, so Open WebUI can populate its selector. */
  @Get('models')
  @Version(VERSION_NEUTRAL)
  @ApiKeyAuth()
  @SkipOrganization()
  @RawResponse()
  listModels(): ModelListResponse {
    return {
      object: 'list',
      data: CAPERE_MODELS.map((model) => ({
        id: model.id,
        object: 'model' as const,
        created: this.mapper.createdAt(),
        owned_by: 'capere',
      })),
    };
  }

  @Post('chat/completions')
  @Version(VERSION_NEUTRAL)
  @ApiKeyAuth()
  @RawResponse()
  async createCompletion(
    @Body() body: ChatCompletionRequestDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const authenticated = request as AuthenticatedRequest;
    const organizationId = authenticated.organizationId;
    const role = authenticated.organizationRole;

    if (!organizationId || !role) {
      throw AppException.forbidden(
        ErrorCode.ORGANIZATION_REQUIRED,
        'This API key is not bound to an organization',
      );
    }

    const message = this.mapper.latestUserMessage(body.messages);
    if (!message.trim()) {
      throw AppException.badRequest(ErrorCode.VALIDATION_FAILED, 'No user message was provided');
    }

    const capability = this.mapper.capabilityFor(body.model);
    if (!capability) {
      throw AppException.badRequest(ErrorCode.VALIDATION_FAILED, `Unknown model "${body.model}"`);
    }
    const priorMessages = body.session_id
      ? []
      : this.mapper.priorMessages(body.messages).map(({ role: messageRole, content }) => ({
          role: messageRole as 'user' | 'assistant',
          content,
        }));

    // Abort the model call if the client disconnects mid-stream, rather than
    // paying for tokens nobody will read.
    const controller = new AbortController();
    request.on('close', () => {
      if (!response.writableEnded) controller.abort();
    });

    const streamingAllowed =
      body.stream === true &&
      (await this.flags.isEnabled(organizationId, FeatureFlag.ChatStreaming));

    if (streamingAllowed) {
      await this.streamCompletion(body, {
        organizationId,
        role,
        userId: authenticated.user?.id,
        capability,
        message,
        priorMessages,
        machineAccess: Boolean(authenticated.apiKeyId),
        response,
        signal: controller.signal,
      });
      return;
    }

    const result = await this.intelligence.execute({
      organizationId,
      userId: authenticated.user?.id,
      role,
      message,
      sessionId: body.session_id,
      machineAccess: Boolean(authenticated.apiKeyId),
      priorMessages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      capability,
      signal: controller.signal,
      ephemeral: !body.session_id,
    });

    const payload: ChatCompletionResponse = {
      id: this.mapper.completionId(),
      object: 'chat.completion',
      created: this.mapper.createdAt(),
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result.content },
          finish_reason: 'stop',
        },
      ],
      // Token counts are recorded per model call in ai_usage_events; the
      // aggregate for a multi-turn orchestration is not a single number, so
      // zeros are reported here rather than a fabricated figure. The ledger is
      // the source of truth for billing.
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      ...(result.sessionId ? { capere_session_id: result.sessionId } : {}),
    };

    response.json(payload);
  }

  /**
   * Streams a completion as server-sent events.
   *
   * Stateless intelligence runs context, tools, and optional review before producing
   * a final answer, so there is no token stream to forward from the model —
   * intermediate tool-calling turns are not the answer. The final text is
   * chunked and emitted instead, which keeps Open WebUI's incremental rendering
   * working while preserving the guarantee that reflection has vetted every
   * word the user sees.
   */
  private async streamCompletion(
    body: ChatCompletionRequestDto,
    params: {
      organizationId: string;
      role: NonNullable<AuthenticatedRequest['organizationRole']>;
      userId?: string;
      capability: NonNullable<ReturnType<ChatMapper['capabilityFor']>>;
      message: string;
      priorMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
      machineAccess: boolean;
      response: Response;
      signal: AbortSignal;
    },
  ): Promise<void> {
    const { response } = params;
    const id = this.mapper.completionId();
    const created = this.mapper.createdAt();

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    // Defeats proxy buffering, which would otherwise defeat streaming entirely.
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    const send = (chunk: ChatCompletionChunk): void => {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    try {
      // Opening frame carries the role, per the OpenAI streaming schema.
      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });

      const result = await this.intelligence.execute({
        organizationId: params.organizationId,
        userId: params.userId,
        role: params.role,
        message: params.message,
        sessionId: body.session_id,
        machineAccess: params.machineAccess,
        priorMessages: params.priorMessages,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        capability: params.capability,
        signal: params.signal,
        ephemeral: !body.session_id,
      });

      // Chunk on word boundaries so the client renders progressively.
      const words = result.content.split(/(\s+)/).filter((w) => w.length > 0);
      for (const word of words) {
        if (params.signal.aborted) break;
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
        });
      }

      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });

      response.write('data: [DONE]\n\n');
    } catch (error) {
      // Headers are already sent, so the global exception filter cannot render
      // an error envelope. Emit the error inside the stream instead — silence
      // would leave the client waiting forever.
      const messageText =
        error instanceof AppException
          ? error.message
          : 'An unexpected error occurred while generating the response.';

      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [
          { index: 0, delta: { content: `\n\n[error] ${messageText}` }, finish_reason: 'stop' },
        ],
      });
      response.write('data: [DONE]\n\n');
    } finally {
      if (!response.writableEnded) response.end();
    }
  }
}
