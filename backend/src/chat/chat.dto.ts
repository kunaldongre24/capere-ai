import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  IsUUID,
} from 'class-validator';

/**
 * OpenAI chat-completions wire format.
 *
 * These DTOs mirror OpenAI's schema because Open WebUI speaks that protocol and
 * we point it at Capere as a custom provider. The shape is therefore NOT ours to
 * design — deviating breaks the client. That is also why the chat controller is
 * `@RawResponse()`: wrapping these in Capere's `{ data, meta }` envelope would
 * make the responses unparseable to Open WebUI.
 */
export class ChatMessageDto {
  @IsIn(['system', 'user', 'assistant', 'tool'])
  role!: 'system' | 'user' | 'assistant' | 'tool';

  // Tool-result messages legitimately carry an empty string.
  @IsString()
  @MaxLength(32_000)
  content!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  tool_call_id?: string;
}

export class ChatCompletionRequestDto {
  /**
   * Model identifier. Open WebUI sends whatever the /v1/models endpoint
   * advertised; Capere maps it to an agent + task type rather than passing it
   * straight through to a provider.
   */
  @IsString()
  model!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages!: ChatMessageDto[];

  @IsOptional()
  @IsBoolean()
  stream?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(16_384)
  max_tokens?: number;

  /**
   * Capere extension: continues an existing session so conversation memory
   * persists across requests. Open WebUI will not send it, which is why the
   * endpoint also works statelessly.
   */
  @IsOptional()
  @IsUUID()
  session_id?: string;
}

// --- Response shapes (constructed, not validated) --------------------------

export interface ChatCompletionChoice {
  index: number;
  message: { role: 'assistant'; content: string };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Capere extension so a client can continue the conversation. */
  capere_session_id?: string;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: string | null;
  }>;
}

export interface ModelListResponse {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }>;
}
