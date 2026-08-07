import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CryptoService } from '../shared/crypto';
import { DatabaseService, type OrgRole } from '../shared/database';
import { AppException, ErrorCode } from '../shared/http';

export interface ResolvedApiKey {
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly roles: OrgRole[];
  readonly ghlLocationId?: string;
}

/**
 * Role seniority, used ONLY to cap what an API key may grant relative to its
 * issuer. Higher rank means more authority.
 *
 * Note this is deliberately NOT a general permission model: route access is
 * decided by explicit `@Roles(...)` lists, not by rank comparison. A marketing
 * manager is not "above" an SEO specialist for access purposes — they simply
 * have different permissions — which is why both sit at the same rank. Ranking
 * them would silently widen access wherever this was reused.
 */
const ROLE_RANK: Readonly<Record<OrgRole, number>> = {
  seo_specialist: 1,
  marketing_manager: 1,
  office_manager: 2,
  owner: 3,
  capere_admin: 4,
};

/**
 * API key issuance and verification.
 *
 * Storage model: only an HMAC-SHA256 hash is persisted, alongside a short
 * plaintext prefix used purely for display ("cap_a1b2c3d4…"). A database dump
 * therefore yields no usable credentials.
 *
 * Lookup is by hash — an exact indexed match on a UNIQUE column — rather than
 * by scanning candidates and comparing. That keeps verification O(1) and avoids
 * the timing signal a linear scan would create.
 */
@Injectable()
export class ApiKeyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Verifies a raw key and returns the identity it grants.
   *
   * Uses the service client deliberately: this runs BEFORE any tenant context
   * exists, so RLS cannot yet be scoped — resolving the key is what establishes
   * the organization in the first place.
   */
  async verify(rawKey: string): Promise<ResolvedApiKey> {
    const hash = this.crypto.hashApiKey(rawKey);

    const record = await this.database.db
      .selectFrom('capere.api_keys as k')
      .leftJoin('capere.organizations as o', 'o.id', 'k.organization_id')
      .select([
        'k.id',
        'k.organization_id',
        sql<OrgRole[]>`k.roles::text[]`.as('roles'),
        'k.ghl_location_id',
        'k.expires_at',
        'k.revoked_at',
        'o.status as organization_status',
      ])
      .where('k.key_hash', '=', hash)
      .executeTakeFirst();

    if (!record) {
      throw AppException.unauthorized(ErrorCode.INVALID_API_KEY, 'API key is not valid');
    }

    if (record.revoked_at) {
      throw AppException.unauthorized(ErrorCode.INVALID_API_KEY, 'API key has been revoked');
    }

    if (record.expires_at && new Date(record.expires_at) <= new Date()) {
      throw AppException.unauthorized(ErrorCode.INVALID_API_KEY, 'API key has expired');
    }

    if (!record.organization_id) {
      throw AppException.forbidden(
        ErrorCode.ORGANIZATION_REQUIRED,
        'API key is not bound to an organization',
      );
    }

    if (record.organization_status !== 'active') {
      throw AppException.forbidden(
        ErrorCode.FORBIDDEN,
        'The organization associated with this API key is not active',
      );
    }

    // `roles` is NOT NULL but an empty array satisfies that, and a key granting
    // no roles cannot authorize anything. Reject it here rather than letting it
    // surface later as a confusing role error on every request it makes.
    if (record.roles.length === 0) {
      throw AppException.forbidden(
        ErrorCode.INSUFFICIENT_ROLE,
        'API key grants no roles and cannot be used',
      );
    }

    // Best-effort usage tracking; a failure here must never reject a valid key.
    void this.touch(record.id);

    return {
      apiKeyId: record.id,
      organizationId: record.organization_id,
      roles: record.roles,
      ghlLocationId: record.ghl_location_id ?? undefined,
    };
  }

  /**
   * Issues a new key. The raw value is returned exactly once and never stored.
   *
   * `issuerRole` is REQUIRED and is not ceremony: without it, a caller could
   * mint a key granting roles they do not themselves hold, turning key issuance
   * into privilege escalation. No Phase 1 controller calls this yet, but the
   * check belongs in the service so the escalation cannot appear the moment a
   * Phase 2 controller wires it up.
   */
  async issue(params: {
    organizationId: string;
    name: string;
    roles: OrgRole[];
    /** The role of the user issuing this key. Caps what may be granted. */
    issuerRole: OrgRole;
    createdBy?: string;
    expiresAt?: Date;
    ghlLocationId?: string;
  }): Promise<{ id: string; rawKey: string; prefix: string }> {
    if (!params.name.trim()) {
      throw AppException.badRequest(ErrorCode.VALIDATION_FAILED, 'An API key name is required');
    }

    if (params.roles.length === 0) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'An API key must grant at least one role',
      );
    }

    const invalidRoles = params.roles.filter((role) => ROLE_RANK[role] === undefined);
    if (invalidRoles.length > 0 || ROLE_RANK[params.issuerRole] === undefined) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        `Unknown organization role: ${[...invalidRoles, params.issuerRole]
          .filter((role) => ROLE_RANK[role] === undefined)
          .join(', ')}`,
      );
    }

    const organization = await this.database.db
      .selectFrom('capere.organizations')
      .select('status')
      .where('id', '=', params.organizationId)
      .executeTakeFirst();

    if (!organization) {
      throw AppException.notFound(ErrorCode.NOT_FOUND, 'Organization was not found');
    }

    if (organization.status !== 'active') {
      throw AppException.forbidden(
        ErrorCode.FORBIDDEN,
        'API keys can only be issued for active organizations',
      );
    }

    const issuerRank = ROLE_RANK[params.issuerRole];
    const overreaching = params.roles.filter((role) => ROLE_RANK[role] > issuerRank);

    if (overreaching.length > 0) {
      throw AppException.forbidden(
        ErrorCode.INSUFFICIENT_ROLE,
        `You cannot issue a key granting a role above your own (${params.issuerRole}): ` +
          `${overreaching.join(', ')}`,
        { issuerRole: params.issuerRole, requested: params.roles },
      );
    }

    const { raw, prefix, hash } = this.crypto.generateApiKey();

    const inserted = await this.database.db
      .insertInto('capere.api_keys')
      .values({
        organization_id: params.organizationId,
        name: params.name,
        key_prefix: prefix,
        key_hash: hash,
        roles: params.roles,
        created_by: params.createdBy ?? null,
        expires_at: params.expiresAt ?? null,
        ghl_location_id: params.ghlLocationId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return { id: inserted.id, rawKey: raw, prefix };
  }

  async revoke(apiKeyId: string, organizationId: string): Promise<void> {
    await this.database.db
      .updateTable('capere.api_keys')
      .set({ revoked_at: new Date() })
      .where('id', '=', apiKeyId)
      .where('organization_id', '=', organizationId)
      .execute();
  }

  private async touch(apiKeyId: string): Promise<void> {
    try {
      await this.database.db
        .updateTable('capere.api_keys')
        .set({ last_used_at: new Date() })
        .where('id', '=', apiKeyId)
        .execute();
    } catch {
      // Deliberately swallowed: last_used_at is telemetry, not authorization.
    }
  }
}
