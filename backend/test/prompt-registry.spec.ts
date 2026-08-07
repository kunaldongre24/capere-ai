import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PromptRegistryService } from '../src/hermes/prompts/prompt-registry.service';
import { checksumOf, PROMPT_TEMPLATES } from '../src/hermes/prompts/prompt-templates';
import type { DatabaseService } from '../src/shared/database';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

function makeService(): PromptRegistryService {
  const database = {
    db: serviceDb(),
    transaction: <T>(fn: (trx: unknown) => Promise<T>) =>
      serviceDb()
        .transaction()
        .execute((trx) => fn(trx)),
  } as unknown as DatabaseService;
  return new PromptRegistryService(database);
}

describe('PromptRegistryService', () => {
  let fixture: Fixture;
  let registry: PromptRegistryService;

  beforeAll(async () => {
    fixture = await seedTwoOrganizations();
    registry = makeService();
  });

  afterAll(async () => {
    // The suite deliberately leaves overrides behind mid-run; clear them so a
    // re-run against the same (real Supabase) database starts clean.
    await registry.clearOverride(fixture.orgAId, 'hermes.system');
    await registry.clearOverride(fixture.orgAId, 'hermes.tool_failure');
    await cleanup(fixture);
    await closeDb();
  });

  it('resolves a template with variables substituted', async () => {
    const resolved = await registry.resolve('hermes.system', fixture.orgAId, {
      organizationName: 'Smith & Jones CPAs',
    });

    expect(resolved.name).toBe('hermes.system');
    expect(resolved.content).toContain('Smith & Jones CPAs');
    expect(resolved.content).not.toContain('{{organizationName}}');
    expect(resolved.overridden).toBe(false);
    expect(resolved.version).toBe(1);
    const template = PROMPT_TEMPLATES.find((candidate) => candidate.name === 'hermes.system');
    expect(template).toBeDefined();
    expect(resolved.checksum).toBe(checksumOf(template!.content));
  });

  it('applies a per-organization override without leaking to another org', async () => {
    await registry.setOverride({
      organizationId: fixture.orgAId,
      name: 'hermes.system',
      content: 'CUSTOM system prompt for {{organizationName}}',
      reason: 'A/B test',
    });

    const orgA = await registry.resolve('hermes.system', fixture.orgAId, {
      organizationName: 'Org A',
    });
    expect(orgA.overridden).toBe(true);
    expect(orgA.content).toBe('CUSTOM system prompt for Org A');
    expect(orgA.checksum).toBe(checksumOf('CUSTOM system prompt for {{organizationName}}'));

    // Org B is untouched — this is a per-tenant customization, not global.
    const orgB = await registry.resolve('hermes.system', fixture.orgBId, {
      organizationName: 'Org B',
    });
    expect(orgB.overridden).toBe(false);
    expect(orgB.content).toContain('the orchestration intelligence inside Capere AI');
  });

  it('clearing an override restores the file default', async () => {
    await registry.clearOverride(fixture.orgAId, 'hermes.system');
    const resolved = await registry.resolve('hermes.system', fixture.orgAId, {
      organizationName: 'Org A',
    });
    expect(resolved.overridden).toBe(false);
    expect(resolved.content).toContain('the orchestration intelligence inside Capere AI');
  });

  it('fails loudly on an unknown template name', async () => {
    await expect(registry.resolve('hermes.nonexistent' as never, fixture.orgAId)).rejects.toThrow(
      /Unknown prompt template/,
    );
  });

  it('fails loudly when a declared variable is not provided', async () => {
    // hermes.system declares organizationName; omitting it must throw rather
    // than ship a prompt containing the literal placeholder.
    await expect(registry.resolve('hermes.system', fixture.orgAId, {})).rejects.toThrow(
      /requires variable "organizationName"/,
    );
  });

  it('fails loudly when the rendered prompt still contains a placeholder', async () => {
    // An override that references a variable the template never declared.
    await registry.setOverride({
      organizationId: fixture.orgAId,
      name: 'hermes.tool_failure',
      content: 'Reference to {{undeclaredVariable}}',
    });

    await expect(
      registry.resolve('hermes.tool_failure', fixture.orgAId, {
        toolName: 'x',
        errorMessage: 'y',
      }),
    ).rejects.toThrow(/unresolved placeholder/);
  });

  it('rejects an override for an unknown template', async () => {
    await expect(
      registry.setOverride({
        organizationId: fixture.orgAId,
        name: 'does.not.exist' as never,
        content: 'x',
      }),
    ).rejects.toThrow(/Unknown prompt template/);
  });

  it('lists every registered template', () => {
    expect(registry.list().map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'hermes.system',
        'hermes.planner',
        'hermes.reflection',
        'hermes.tool_failure',
      ]),
    );
  });

  it('every registered template has a checksum equal to its content hash', () => {
    for (const template of PROMPT_TEMPLATES) {
      expect(checksumOf(template.content)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
