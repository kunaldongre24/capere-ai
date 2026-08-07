import { Injectable } from '@nestjs/common';
import { DatabaseService, type OrgRole } from '../shared/database';

export interface Membership {
  readonly organizationId: string;
  readonly role: OrgRole;
  readonly organizationName: string;
}

/**
 * Organization membership lookups.
 *
 * Uses the service client because membership is what ESTABLISHES tenant
 * context — an RLS-scoped query would need the very context this resolves,
 * which is circular. Every query here is explicitly filtered by user_id.
 */
@Injectable()
export class MembershipService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * The caller's role in one organization, or undefined if not a member.
   *
   * The `status = 'active'` filter is load-bearing and must match `listFor`.
   * OrganizationGuard reaches this method via the `X-Organization-Id` header
   * path and `listFor` via the sole-membership path; if only one filtered on
   * status, a member of a suspended or cancelled organization could regain
   * access simply by naming the organization explicitly. No RLS policy
   * references `organizations.status`, so the database does not close that gap
   * either — both paths agreeing here is the only thing that does.
   */
  async roleFor(userId: string, organizationId: string): Promise<OrgRole | undefined> {
    const row = await this.database.db
      .selectFrom('capere.organization_members as m')
      .innerJoin('capere.organizations as o', 'o.id', 'm.organization_id')
      .select('m.role')
      .where('m.user_id', '=', userId)
      .where('m.organization_id', '=', organizationId)
      .where('o.status', '=', 'active')
      .executeTakeFirst();

    return row?.role;
  }

  /** Every organization the caller belongs to. */
  async listFor(userId: string): Promise<Membership[]> {
    const rows = await this.database.db
      .selectFrom('capere.organization_members as m')
      .innerJoin('capere.organizations as o', 'o.id', 'm.organization_id')
      .select(['m.organization_id', 'm.role', 'o.name'])
      .where('m.user_id', '=', userId)
      .where('o.status', '=', 'active')
      .orderBy('o.name')
      .execute();

    return rows.map((row) => ({
      organizationId: row.organization_id,
      role: row.role,
      organizationName: row.name,
    }));
  }

  async isMember(userId: string, organizationId: string): Promise<boolean> {
    return (await this.roleFor(userId, organizationId)) !== undefined;
  }
}
