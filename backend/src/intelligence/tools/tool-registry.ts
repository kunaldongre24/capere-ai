import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AgentKind, OrgRole } from '../../shared/database';
import type { Tool, ToolContext, ToolDescriptor, ToolResult } from './tool.interface';

/**
 * The tool registry.
 *
 * Every tool invocation goes through `execute` here, which is what makes the
 * guarantees uniform. Concretely, the registry — not the tool — is responsible
 * for:
 *
 *   1. **Existence.** An unknown tool name returns a structured error the model
 *      can recover from, rather than throwing and killing the run. Models
 *      hallucinate tool names; that must be survivable.
 *   2. **Schema validation.** Arguments arrive as a raw JSON string from the
 *      model and are never trusted. Zod parses them, and a failure returns the
 *      field-level detail so the model can correct itself on the next turn.
 *   3. **Permissions.** Checked against the CALLER's role, not the model's
 *      request. A model asking to call a tool is not authorization to run it —
 *      this is the boundary that stops prompt injection from escalating into
 *      real action.
 *   4. **Timeouts.** Every call races an AbortController deadline, so one hung
 *      integration cannot stall the orchestration loop indefinitely.
 *   5. **Telemetry.** Duration and outcome for every call, in one place.
 *
 * Errors are RETURNED, not thrown. The orchestrator feeds a failed ToolResult
 * back to the model as a tool message so it can adapt — which is strictly more
 * useful than aborting the conversation.
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, Tool<never, unknown>>();

  /** Registers a tool. Duplicate names are a programming error. */
  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered. Tool names must be unique.`);
    }

    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) {
      // Providers constrain tool names; catching it at registration beats a
      // confusing 400 from the model gateway at request time.
      throw new Error(
        `Tool name "${tool.name}" is invalid. Use snake_case, starting with a ` +
          'letter, max 64 characters.',
      );
    }

    this.tools.set(tool.name, tool as unknown as Tool<never, unknown>);
    this.logger.debug(`Registered tool "${tool.name}"`);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool<never, unknown> | undefined {
    return this.tools.get(name);
  }

  /**
   * Tools this role may use, in the provider-neutral descriptor shape.
   *
   * Filtered by permission BEFORE being offered to the model: a tool the caller
   * could not run should never appear in the model's options, or it will call
   * it and receive a denial it cannot act on.
   */
  descriptorsFor(
    role: OrgRole,
    options: { includeMutating?: boolean; agent?: AgentKind } = {},
  ): ToolDescriptor[] {
    const includeMutating = options.includeMutating ?? true;

    return [...this.tools.values()]
      .filter((tool) => tool.permissions.includes(role))
      .filter((tool) => !tool.agents || !options.agent || tool.agents.includes(options.agent))
      .filter((tool) => includeMutating || !tool.mutates)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: this.jsonSchemaFor(tool),
      }));
  }

  /** Every registered tool name — for diagnostics and the monitoring endpoint. */
  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /**
   * Validates, authorizes, and runs a tool call.
   *
   * @param rawArguments JSON string as emitted by the model. Never trusted.
   */
  async execute(toolName: string, rawArguments: string, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const tool = this.tools.get(toolName);

    if (!tool) {
      // Models hallucinate tool names. Tell it what actually exists so the next
      // turn can correct itself.
      return this.failure(toolName, startedAt, 'not_found', {
        message: `No tool named "${toolName}". Available tools: ${this.names().join(', ') || 'none'}.`,
      });
    }

    if (!tool.permissions.includes(context.role)) {
      this.logger.warn(
        `Role "${context.role}" denied tool "${toolName}" ` +
          `(organization ${context.organizationId})`,
      );
      return this.failure(toolName, startedAt, 'permission_denied', {
        message: `Your role (${context.role}) is not permitted to use "${toolName}".`,
      });
    }

    if (tool.agents && !tool.agents.includes(context.agent)) {
      return this.failure(toolName, startedAt, 'permission_denied', {
        message: `The ${context.agent} capability is not permitted to use "${toolName}".`,
      });
    }

    let parsedArguments: unknown;
    try {
      // An empty argument string is a legitimate no-parameter call.
      parsedArguments = rawArguments.trim() ? JSON.parse(rawArguments) : {};
    } catch {
      return this.failure(toolName, startedAt, 'invalid_input', {
        message: 'Arguments were not valid JSON.',
        details: { received: rawArguments.slice(0, 200) },
      });
    }

    const validation = tool.schema.safeParse(parsedArguments);
    if (!validation.success) {
      return this.failure(toolName, startedAt, 'invalid_input', {
        message: `Arguments did not match the schema for "${toolName}".`,
        // Field-level detail so the model can fix its own call.
        details: validation.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    // Combine the caller's signal with this tool's own deadline, so either can
    // cancel the work.
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    context.signal.addEventListener('abort', onExternalAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), tool.timeoutMs);

    try {
      const output = await (tool as unknown as Tool<unknown, unknown>).execute(validation.data, {
        ...context,
        signal: controller.signal,
      });

      const durationMs = Date.now() - startedAt;
      this.logger.debug(`Tool "${toolName}" completed in ${durationMs}ms`);

      return { toolName, ok: true, output, durationMs };
    } catch (error) {
      if (controller.signal.aborted) {
        const externallyAborted = context.signal.aborted;
        return this.failure(toolName, startedAt, 'timeout', {
          message: externallyAborted
            ? `Tool "${toolName}" was cancelled.`
            : `Tool "${toolName}" exceeded its ${tool.timeoutMs}ms deadline.`,
        });
      }

      // The model sees a short message; the full error stays in our logs. A
      // tool's internal exception can contain connection strings or tokens.
      this.logger.error(
        `Tool "${toolName}" threw: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );

      return this.failure(toolName, startedAt, 'execution_failed', {
        message: `"${toolName}" failed to complete. The underlying error has been logged.`,
      });
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Converts a tool's Zod schema to JSON Schema for the provider.
   *
   * Hand-rolled for the subset actually used in tool parameters (objects of
   * primitives, enums, arrays, optionals) rather than pulling in a converter
   * dependency. Falls back to a permissive object for anything unsupported,
   * because a slightly loose schema is better than a failed registration —
   * the Zod parse in `execute` is the real gate either way.
   */
  private jsonSchemaFor(tool: Tool<never, unknown>): Record<string, unknown> {
    return zodToJsonSchema(tool.schema as z.ZodTypeAny);
  }

  private failure(
    toolName: string,
    startedAt: number,
    code: NonNullable<ToolResult['error']>['code'],
    error: { message: string; details?: unknown },
  ): ToolResult {
    return {
      toolName,
      ok: false,
      error: { code, message: error.message, details: error.details },
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Minimal Zod -> JSON Schema conversion.
 *
 * Exported for testing. Deliberately covers only what tool parameters need.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName?: string } & Record<string, unknown>;

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        const field = value as z.ZodTypeAny;
        properties[key] = zodToJsonSchema(field);
        if (!field.isOptional()) required.push(key);
      }

      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }

    case z.ZodFirstPartyTypeKind.ZodString: {
      const description = schema.description;
      return { type: 'string', ...(description ? { description } : {}) };
    }

    case z.ZodFirstPartyTypeKind.ZodNumber:
      return { type: 'number', ...(schema.description ? { description: schema.description } : {}) };

    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return {
        type: 'boolean',
        ...(schema.description ? { description: schema.description } : {}),
      };

    case z.ZodFirstPartyTypeKind.ZodEnum:
      return {
        type: 'string',
        enum: [...(def.values as string[])],
        ...(schema.description ? { description: schema.description } : {}),
      };

    case z.ZodFirstPartyTypeKind.ZodArray:
      return {
        type: 'array',
        items: zodToJsonSchema(def.type as z.ZodTypeAny),
        ...(schema.description ? { description: schema.description } : {}),
      };

    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return zodToJsonSchema(def.innerType as z.ZodTypeAny);

    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { const: def.value };

    default:
      // Unsupported construct: stay permissive here and let the Zod parse in
      // execute() do the real validation.
      return { type: 'object', additionalProperties: true };
  }
}
