import type { z } from 'zod';
import type { AgentKind, OrgRole } from '../../shared/database';

/**
 * The tool contract.
 *
 * Every capability stateless intelligence can invoke implements this
 * one interface. That uniformity is the point: the registry enforces schema
 * validation, permissions, timeouts and telemetry ONCE, so no individual tool
 * reimplements them and none can accidentally skip them.
 *
 * Type parameters carry the input and output types through, so an agent calling
 * a tool gets real types rather than `unknown`.
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  /** Stable snake_case identifier exposed to the model. */
  readonly name: string;

  /**
   * Description the MODEL reads to decide whether to call this tool. Write it
   * for the model, not for a developer: state what it returns and when to use
   * it. A vague description is the most common cause of a tool never being
   * called, or being called for the wrong thing.
   */
  readonly description: string;

  /** Zod schema for the input. Also emitted as JSON Schema for tool calling. */
  readonly schema: z.ZodType<TInput>;

  /**
   * Roles permitted to invoke this tool. Checked against the CALLER's role in
   * the active organization before execution — a model asking for a tool does
   * not grant permission to run it.
   */
  readonly permissions: readonly OrgRole[];

  /** Agent capabilities allowed to see and execute this tool. Omitted means all agents. */
  readonly agents?: readonly AgentKind[];

  /**
   * Hard execution deadline. A hung tool would otherwise stall the whole
   * orchestration loop and, with streaming, leave the user watching nothing.
   */
  readonly timeoutMs: number;

  /**
   * True when this tool changes state (writes to GHL, creates a task, posts
   * content). Mutating tools are excluded from speculative or planning-only
   * runs, because a plan that has already sent the email is not a plan.
   */
  readonly mutates?: boolean;

  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

/**
 * Execution context handed to every tool.
 *
 * Carries verified identity explicitly rather than letting tools reach into
 * ambient state — a tool must not be able to widen its own scope.
 */
export interface ToolContext {
  readonly organizationId: string;
  readonly userId?: string;
  readonly role: OrgRole;
  readonly sessionId?: string;
  readonly agent: AgentKind;
  /** Aborted when the deadline passes or the caller disconnects. */
  readonly signal: AbortSignal;
}

/** Outcome of a registry-mediated tool invocation. */
export interface ToolResult<TOutput = unknown> {
  readonly toolName: string;
  readonly ok: boolean;
  readonly output?: TOutput;
  readonly error?: {
    readonly code:
      'not_found' | 'invalid_input' | 'permission_denied' | 'timeout' | 'execution_failed';
    readonly message: string;
    /** Field-level detail for invalid_input, so the model can correct itself. */
    readonly details?: unknown;
  };
  readonly durationMs: number;
}

/** Tool description in the provider-neutral shape the LLM port expects. */
export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
