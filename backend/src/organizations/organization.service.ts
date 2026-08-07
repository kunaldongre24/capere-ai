import { Injectable } from '@nestjs/common';
import { DatabaseService, type Database, type OrgRole } from '../shared/database';
import type { Transaction } from 'kysely';
import { AppException, ErrorCode } from '../shared/http';
import type {
  AddOrganizationMemberDto,
  CreateOrganizationDto,
  UpdateOrganizationDto,
  UpdateOrganizationMemberDto,
} from './organization.dto';

@Injectable()
export class OrganizationService {
  constructor(private readonly database: DatabaseService) {}

  async ensureProfile(userId: string, email?: string) {
    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail) {
      throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Authenticated user has no email claim');
    }
    return this.database.db
      .insertInto('capere.users')
      .values({
        id: userId,
        email: normalizedEmail,
        full_name: null,
        avatar_url: null,
        last_seen_at: new Date(),
      })
      .onConflict((conflict) =>
        conflict.column('id').doUpdateSet({ email: normalizedEmail, last_seen_at: new Date() }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async create(userId: string, email: string | undefined, dto: CreateOrganizationDto) {
    await this.ensureProfile(userId, email);
    try {
      return await this.database.transaction(async (trx) => {
        const organization = await trx
          .insertInto('capere.organizations')
          .values({ name: dto.name.trim(), slug: dto.slug })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('capere.organization_members')
          .values({
            organization_id: organization.id,
            user_id: userId,
            role: 'owner',
            invited_by: userId,
          })
          .execute();
        return organization;
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw AppException.conflict(ErrorCode.CONFLICT, 'Organization slug is already in use');
      }
      throw error;
    }
  }

  listForUser(userId: string) {
    return this.database.db
      .selectFrom('capere.organization_members as m')
      .innerJoin('capere.organizations as o', 'o.id', 'm.organization_id')
      .select(['o.id', 'o.name', 'o.slug', 'o.status', 'm.role', 'o.created_at', 'o.updated_at'])
      .where('m.user_id', '=', userId)
      .orderBy('o.name')
      .execute();
  }

  getProfile(userId: string) {
    return this.database.db
      .selectFrom('capere.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
  }

  async get(organizationId: string) {
    const organization = await this.database.db
      .selectFrom('capere.organizations')
      .selectAll()
      .where('id', '=', organizationId)
      .executeTakeFirst();
    if (!organization) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Organization not found');
    return organization;
  }

  async update(organizationId: string, dto: UpdateOrganizationDto) {
    try {
      return await this.database.db
        .updateTable('capere.organizations')
        .set({
          ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
          ...(dto.slug === undefined ? {} : { slug: dto.slug }),
        })
        .where('id', '=', organizationId)
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw AppException.conflict(ErrorCode.CONFLICT, 'Organization slug is already in use');
      }
      throw error;
    }
  }

  listMembers(organizationId: string) {
    return this.database.db
      .selectFrom('capere.organization_members as m')
      .innerJoin('capere.users as u', 'u.id', 'm.user_id')
      .select([
        'm.id',
        'm.user_id',
        'm.role',
        'm.joined_at',
        'u.email',
        'u.full_name',
        'u.avatar_url',
      ])
      .where('m.organization_id', '=', organizationId)
      .orderBy('u.email')
      .execute();
  }

  async addMember(organizationId: string, actorId: string, dto: AddOrganizationMemberDto) {
    const user = await this.database.db
      .selectFrom('capere.users')
      .select('id')
      .where('id', '=', dto.userId)
      .executeTakeFirst();
    if (!user) {
      throw AppException.notFound(
        ErrorCode.NOT_FOUND,
        'User profile not found; provision the user through Supabase Auth first',
      );
    }
    try {
      return await this.database.db
        .insertInto('capere.organization_members')
        .values({
          organization_id: organizationId,
          user_id: dto.userId,
          role: dto.role,
          invited_by: actorId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw AppException.conflict(ErrorCode.CONFLICT, 'User is already an organization member');
      }
      throw error;
    }
  }

  async updateMember(organizationId: string, memberId: string, dto: UpdateOrganizationMemberDto) {
    return this.database.transaction(async (trx) => {
      await this.lockOrganization(trx, organizationId);
      const member = await trx
        .selectFrom('capere.organization_members')
        .select(['id', 'role'])
        .where('id', '=', memberId)
        .where('organization_id', '=', organizationId)
        .forUpdate()
        .executeTakeFirst();
      if (!member) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Member not found');
      if (member.role === 'capere_admin') {
        throw AppException.forbidden(
          ErrorCode.FORBIDDEN,
          'Capere administrator roles are system-managed',
        );
      }
      if (member.role === 'owner' && dto.role !== 'owner')
        await this.assertAnotherOwner(trx, organizationId, memberId);
      return trx
        .updateTable('capere.organization_members')
        .set({ role: dto.role })
        .where('id', '=', memberId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async removeMember(organizationId: string, memberId: string): Promise<{ removed: true }> {
    await this.database.transaction(async (trx) => {
      await this.lockOrganization(trx, organizationId);
      const member = await trx
        .selectFrom('capere.organization_members')
        .select(['id', 'role'])
        .where('id', '=', memberId)
        .where('organization_id', '=', organizationId)
        .forUpdate()
        .executeTakeFirst();
      if (!member) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Member not found');
      if (member.role === 'capere_admin') {
        throw AppException.forbidden(
          ErrorCode.FORBIDDEN,
          'Capere administrators cannot be removed here',
        );
      }
      if (member.role === 'owner') await this.assertAnotherOwner(trx, organizationId, memberId);
      await trx.deleteFrom('capere.organization_members').where('id', '=', memberId).execute();
    });
    return { removed: true };
  }

  private async lockOrganization(
    trx: Transaction<Database>,
    organizationId: string,
  ): Promise<void> {
    const organization = await trx
      .selectFrom('capere.organizations')
      .select('id')
      .where('id', '=', organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!organization) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Organization not found');
  }

  private async assertAnotherOwner(
    trx: Transaction<Database>,
    organizationId: string,
    excludedMemberId: string,
  ) {
    // Lock the complete owner set. Concurrent demotions/removals then serialize,
    // so two owners cannot both observe the other and leave the organization
    // ownerless.
    const owners = await trx
      .selectFrom('capere.organization_members')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('role', '=', 'owner' as OrgRole)
      .forUpdate()
      .execute();
    if (!owners.some((owner) => owner.id !== excludedMemberId))
      throw AppException.conflict(
        ErrorCode.CONFLICT,
        'Organization must retain at least one owner',
      );
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }
}
