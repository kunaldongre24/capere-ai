import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../shared/database';
import {
  FEATURE_FLAG_DEFINITIONS,
  type FeatureFlagDefinition,
  type FeatureFlagKey,
} from './feature-flag.catalog';

/**
 * Organization-level feature flags.
 *
 * Evaluation order, per flag:
 *   1. Organization override   (organization_feature_flags row) — wins
 *   2. Global default          (feature_flags.default_enabled / catalog)
 *
 * An organization can thereby be added to a beta, or excluded from a risky
 * rollout, without a deploy. This is the mechanism behind gradual rollouts and
 * emergency toggles.
 *
 * All reads go through the SERVICE client. A flag evaluation runs inside a
 * request before or outside of any tenant context, and reading flags as the
 * user would couple authorization to RLS policies that themselves need flags.
 * Organization scoping is explicit in every query, never assumed.
 *
 * A one-minute in-process cache limits load. Invalidation happens on write, so
 * a toggle takes effect immediately.
 */
@Injectable()
export class FeatureFlagService {
  /** orgId -> key -> { value, expiresAt } */
  private readonly cache = new Map<string, Map<string, { value: boolean; expiresAt: number }>>();
  private readonly cacheTtlMs = 60_000;

  constructor(private readonly database: DatabaseService) {}

  /** True when `key` is enabled for `organizationId`. */
  async isEnabled(organizationId: string, key: FeatureFlagKey): Promise<boolean> {
    const definition = this.definition(key);

    // Fast path: a warm cached override.
    const cached = this.cache.get(organizationId)?.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now()) return cached.value;
      this.cache.get(organizationId)?.delete(key);
    }

    const value = await this.loadEffectiveValue(organizationId, definition);

    this.remember(organizationId, key, value);
    return value;
  }

  /** Enables or disables `key` for an organization, immediately. */
  async setOverride(
    organizationId: string,
    key: FeatureFlagKey,
    enabled: boolean,
    options: { changedBy?: string; reason?: string } = {},
  ): Promise<void> {
    const definition = this.definition(key);

    const flag = await this.database.db
      .selectFrom('capere.feature_flags')
      .select('id')
      .where('key', '=', key)
      .executeTakeFirst();

    const flagId =
      flag?.id ??
      (
        await this.database.db
          .insertInto('capere.feature_flags')
          .values({
            key,
            description: definition.description,
            default_enabled: definition.defaultEnabled,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;

    await this.database.db
      .insertInto('capere.organization_feature_flags')
      .values({
        organization_id: organizationId,
        flag_id: flagId,
        enabled,
        changed_by: options.changedBy ?? null,
        reason: options.reason ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'flag_id']).doUpdateSet({
          enabled,
          changed_by: options.changedBy ?? null,
          reason: options.reason ?? null,
          updated_at: new Date(),
        }),
      )
      .execute();

    // Invalidate immediately so the change is effective without waiting out the TTL.
    this.invalidate(organizationId, key);
  }

  /** Effective value for every flag, for an admin settings screen. */
  async allFor(
    organizationId: string,
  ): Promise<Array<FeatureFlagDefinition & { enabled: boolean }>> {
    return Promise.all(
      FEATURE_FLAG_DEFINITIONS.map(async (definition) => ({
        ...definition,
        enabled: await this.isEnabled(organizationId, definition.key),
      })),
    );
  }

  private definition(key: FeatureFlagKey): FeatureFlagDefinition {
    const definition = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === key);
    if (!definition) {
      throw new Error(`Unknown feature flag "${key}". Declare it in feature-flag.catalog.ts.`);
    }
    return definition;
  }

  private async loadEffectiveValue(
    organizationId: string,
    definition: FeatureFlagDefinition,
  ): Promise<boolean> {
    const override = await this.database.db
      .selectFrom('capere.organization_feature_flags as off')
      .innerJoin('capere.feature_flags as f', 'f.id', 'off.flag_id')
      .select('off.enabled')
      .where('off.organization_id', '=', organizationId)
      .where('f.key', '=', definition.key)
      .executeTakeFirst();

    return override?.enabled ?? definition.defaultEnabled;
  }

  private remember(organizationId: string, key: FeatureFlagKey, value: boolean): void {
    let org = this.cache.get(organizationId);
    if (!org) {
      org = new Map();
      this.cache.set(organizationId, org);
    }
    org.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
  }

  private invalidate(organizationId: string, key: FeatureFlagKey): void {
    this.cache.get(organizationId)?.delete(key);
  }
}
