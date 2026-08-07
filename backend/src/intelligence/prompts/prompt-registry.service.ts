import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/database';
import { AppException, ErrorCode } from '../../shared/http';
import {
  checksumOf,
  PROMPT_TEMPLATES,
  type PromptName,
  type PromptTemplate,
} from './prompt-templates';

export interface ResolvedPrompt {
  readonly name: string;
  readonly content: string;
  readonly version: number;
  readonly checksum: string;
  /** True when a per-organization override was applied. */
  readonly overridden: boolean;
}

/**
 * Prompt resolution with per-organization overrides.
 *
 * Resolution order:
 *   1. Organization override (prompt_overrides row) — wins.
 *   2. Registered file template (this code).
 *
 * The resolved version and checksum are returned so the caller can record them
 * on the usage event — that is what keeps outputs attributable to a prompt
 * revision.
 *
 * Note on registration: templates are NOT re-seeded from code on every
 * resolution. The DB row is a convenience for admins and for the override
 * table's FK; code is authoritative for the default content, which is why
 * resolution here reads the file, not the DB.
 */
@Injectable()
export class PromptRegistryService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Resolves a template, substituting variables and applying any override.
   *
   * @throws AppException NOT_FOUND for an unknown prompt name — a typo should
   *         fail loudly rather than silently ship an empty prompt to a model.
   */
  async resolve(
    name: PromptName,
    organizationId: string,
    variables: Record<string, string> = {},
  ): Promise<ResolvedPrompt> {
    const template = this.templateFor(name);

    const override = await this.database.db
      .selectFrom('capere.prompt_overrides')
      .select('content')
      .where('organization_id', '=', organizationId)
      .where('name', '=', name)
      .executeTakeFirst();

    const source = override ? override.content : template.content;
    const content = this.render(source, template, variables);

    return {
      name,
      content,
      // An override does not carry a version of its own — the version identifies
      // the FILE template it replaces, and the checksum identifies the exact
      // bytes that were actually sent. Together they answer "which revision
      // produced this output, and was it customized?".
      version: template.version,
      checksum: checksumOf(source),
      overridden: override !== undefined,
    };
  }

  /** Lists every registered template — for an admin/dev UI. */
  list(): PromptTemplate[] {
    return [...PROMPT_TEMPLATES];
  }

  /**
   * Upserts a per-organization override.
   *
   * The checksum is computed here, so the stored row can never drift from the
   * content that was actually resolved.
   */
  async setOverride(params: {
    organizationId: string;
    name: PromptName;
    content: string;
    reason?: string;
    createdBy?: string;
  }): Promise<void> {
    // Rejects an unknown name before writing a row nothing will ever read.
    this.templateFor(params.name);

    await this.database.db
      .insertInto('capere.prompt_overrides')
      .values({
        organization_id: params.organizationId,
        name: params.name,
        content: params.content,
        checksum: checksumOf(params.content),
        reason: params.reason ?? null,
        created_by: params.createdBy ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'name']).doUpdateSet({
          content: params.content,
          checksum: checksumOf(params.content),
          reason: params.reason ?? null,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  /** Removes an organization's override, restoring the file default. */
  async clearOverride(organizationId: string, name: PromptName): Promise<void> {
    await this.database.db
      .deleteFrom('capere.prompt_overrides')
      .where('organization_id', '=', organizationId)
      .where('name', '=', name)
      .execute();
  }

  private templateFor(name: PromptName): PromptTemplate {
    const template = PROMPT_TEMPLATES.find((t) => t.name === name);
    if (!template) {
      throw AppException.notFound(
        ErrorCode.NOT_FOUND,
        `Unknown prompt template "${name}". Declare it in prompt-templates.ts.`,
      );
    }
    return template;
  }

  /**
   * Substitutes {{variable}} placeholders.
   *
   * Declared variables are checked against the template so a typo in either the
   * template or the caller is caught loudly instead of producing a prompt with
   * a literal '{{orgName}}' in it.
   */
  private render(
    content: string,
    template: PromptTemplate,
    variables: Record<string, string>,
  ): string {
    let rendered = content;

    for (const variable of template.variables) {
      const value = variables[variable];
      if (value === undefined) {
        throw new AppException(
          ErrorCode.INTERNAL_ERROR,
          `Prompt "${template.name}" requires variable "${variable}" but none was provided.`,
          500,
        );
      }
      rendered = rendered.replaceAll(`{{${variable}}}`, value);
    }

    // A leftover placeholder is a template/registry bug — fail loudly.
    const leftover = rendered.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/);
    if (leftover) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `Prompt "${template.name}" has an unresolved placeholder "{{${leftover[1]}}}" ` +
          `not declared in its variables list.`,
        500,
      );
    }

    return rendered;
  }
}
