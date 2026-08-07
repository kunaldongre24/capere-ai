import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../../shared/database';
import { AppException, ErrorCode } from '../../shared/http';
import { GithubAdapter } from './github.adapter';
import type {
  AddRepositoryDto,
  ConnectGithubDto,
  CreateChangeRequestDto,
  FileChangeDto,
} from './github.dto';

@Injectable()
export class GithubService {
  constructor(
    private readonly database: DatabaseService,
    private readonly github: GithubAdapter,
  ) {}

  async connect(organizationId: string, dto: ConnectGithubDto) {
    await this.github.installationToken(dto.installationId);
    return this.database.transaction(async (trx) => {
      const integration = await trx
        .insertInto('capere.integrations')
        .values({
          organization_id: organizationId,
          ghl_location_id: null,
          provider: 'github',
          account_id: dto.installationId,
          account_name: dto.accountLogin,
          status: 'connected',
          encrypted_credentials: null,
          key_version: 1,
          scopes: 'read_write',
          token_type: 'GitHub-App',
          expires_at: null,
          last_sync_at: null,
          last_error: null,
          provider_metadata: JSON.stringify({ accountType: dto.accountType }),
          authorization_id: null,
          sync_enabled: true,
        })
        .onConflict((c) =>
          c
            .columns(['organization_id', 'provider', 'account_id'])
            .where('provider', '<>', 'go_high_level')
            .doUpdateSet({ account_name: dto.accountLogin, status: 'connected', last_error: null }),
        )
        .returning(['id', 'provider', 'status'])
        .executeTakeFirstOrThrow();
      const installation = await trx
        .insertInto('capere.github_installations')
        .values({
          organization_id: organizationId,
          integration_id: integration.id,
          installation_id: dto.installationId,
          account_login: dto.accountLogin,
          account_type: dto.accountType,
        })
        .onConflict((c) =>
          c.columns(['organization_id', 'installation_id']).doUpdateSet({
            account_login: dto.accountLogin,
            account_type: dto.accountType,
            integration_id: integration.id,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return { integration, installation };
    });
  }

  addRepository(organizationId: string, installationId: string, dto: AddRepositoryDto) {
    return this.database.db
      .insertInto('capere.github_repositories')
      .values({
        organization_id: organizationId,
        installation_id: installationId,
        repository_id: dto.repositoryId,
        owner: dto.owner,
        name: dto.name,
        default_branch: dto.defaultBranch,
        private: dto.private,
        metadata: JSON.stringify({}),
        analyzed_at: null,
      })
      .onConflict((c) =>
        c.columns(['organization_id', 'repository_id']).doUpdateSet({
          owner: dto.owner,
          name: dto.name,
          default_branch: dto.defaultBranch,
          private: dto.private,
          installation_id: installationId,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async analyze(organizationId: string, repositoryId: string) {
    const repo = await this.repository(organizationId, repositoryId);
    const token = await this.token(repo.installation_id, organizationId);
    const tree = await this.github.getJson<{
      tree?: Array<{ path?: string; type?: string; size?: number }>;
    }>(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`,
      token,
    );
    const files = (tree.tree ?? [])
      .filter((x) => x.type === 'blob' && (x.size ?? 0) <= 500_000 && this.safePath(x.path ?? ''))
      .slice(0, 5000);
    const summary = {
      fileCount: files.length,
      extensions: this.extensions(files.map((f) => f.path ?? '')),
      hasPackageJson: files.some((f) => f.path === 'package.json'),
      hasRobotsTxt: files.some((f) => f.path === 'robots.txt'),
      hasSitemap: files.some((f) => f.path?.includes('sitemap')),
    };
    await this.database.db
      .updateTable('capere.github_repositories')
      .set({ metadata: JSON.stringify(summary), analyzed_at: new Date() })
      .where('id', '=', repo.id)
      .execute();
    return summary;
  }

  async createChangeRequest(
    organizationId: string,
    repositoryId: string,
    userId: string,
    dto: CreateChangeRequestDto,
  ) {
    for (const change of dto.changes) this.validateChange(change);
    return this.database.db
      .insertInto('capere.github_change_requests')
      .values({
        organization_id: organizationId,
        repository_id: repositoryId,
        status: 'draft',
        title: dto.title,
        description: dto.description ?? null,
        base_sha: dto.baseSha,
        changes: JSON.stringify(dto.changes),
        approved_by: null,
        approved_at: null,
        branch_name: null,
        pull_request_number: null,
        pull_request_url: null,
        error: null,
        created_by: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async approveAndExecute(organizationId: string, requestId: string, userId: string) {
    return this.database.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`github-change:${requestId}`},0))`.execute(
        trx,
      );
      const row = await trx
        .selectFrom('capere.github_change_requests')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', requestId)
        .where('status', '=', 'draft')
        .forUpdate()
        .executeTakeFirst();
      if (!row)
        throw AppException.badRequest(
          ErrorCode.CONFLICT,
          'Change request is not awaiting approval',
        );
      await trx
        .updateTable('capere.github_change_requests')
        .set({ status: 'approved', approved_by: userId, approved_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await trx
        .insertInto('capere.scheduled_jobs')
        .values({
          organization_id: organizationId,
          job_type: 'github-change-execute',
          name: `github-change-execute:${row.id}`,
          schedule: 'hourly',
          enabled: true,
          next_run_at: new Date(),
          payload: JSON.stringify({ requestId: row.id }),
        })
        .onConflict((c) =>
          c.columns(['organization_id', 'name']).doUpdateSet({
            enabled: true,
            next_run_at: new Date(),
          }),
        )
        .execute();
      return { requestId: row.id, status: 'approved' as const };
    });
  }

  async executeApproved(organizationId: string, requestId: string) {
    const request = await this.database.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`github-change:${requestId}`},0))`.execute(
        trx,
      );
      const row = await trx
        .selectFrom('capere.github_change_requests')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', requestId)
        .where('status', '=', 'approved')
        .forUpdate()
        .executeTakeFirst();
      if (!row)
        throw AppException.badRequest(ErrorCode.CONFLICT, 'Change request is not executable');
      await trx
        .updateTable('capere.github_change_requests')
        .set({ status: 'executing', error: null })
        .where('id', '=', row.id)
        .where('status', '=', 'approved')
        .execute();
      return row;
    });
    const repo = await this.repository(organizationId, request.repository_id);
    const token = await this.token(repo.installation_id, organizationId);
    const branch = `capere/${request.id.slice(0, 8)}`;
    const changes = request.changes as FileChangeDto[];
    try {
      let branchExists = false;
      try {
        await this.github.getJson(
          `/repos/${repo.owner}/${repo.name}/git/ref/heads/${encodeURIComponent(branch)}`,
          token,
        );
        branchExists = true;
      } catch {
        branchExists = false;
      }
      if (!branchExists) {
        const ref = await this.github.getJson<{ object: { sha: string } }>(
          `/repos/${repo.owner}/${repo.name}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`,
          token,
        );
        if (ref.object.sha !== request.base_sha)
          throw new Error('Default branch changed since this request was prepared');
        await this.github.request(`/repos/${repo.owner}/${repo.name}/git/refs`, 'POST', token, {
          ref: `refs/heads/${branch}`,
          sha: request.base_sha,
        });
      }
      for (const change of changes) {
        this.validateChange(change);
        let sha: string | undefined;
        try {
          sha = (
            await this.github.getJson<{ sha: string }>(
              `/repos/${repo.owner}/${repo.name}/contents/${change.path}?ref=${encodeURIComponent(branch)}`,
              token,
            )
          ).sha;
        } catch {
          sha = undefined;
        }
        await this.github.request(
          `/repos/${repo.owner}/${repo.name}/contents/${change.path}`,
          'PUT',
          token,
          {
            message: `Capere: ${request.title}`,
            content: Buffer.from(change.content).toString('base64'),
            branch,
            ...(sha ? { sha } : {}),
          },
        );
      }
      const existingPulls = await this.github.getJson<Array<{ number: number; html_url: string }>>(
        `/repos/${repo.owner}/${repo.name}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${branch}`)}`,
        token,
      );
      const pr =
        existingPulls[0] ??
        (await this.github.request<{ number: number; html_url: string }>(
          `/repos/${repo.owner}/${repo.name}/pulls`,
          'POST',
          token,
          {
            title: request.title,
            body: request.description ?? '',
            head: branch,
            base: repo.default_branch,
          },
        ));
      await this.database.db
        .updateTable('capere.github_change_requests')
        .set({
          status: 'pull_request_opened',
          branch_name: branch,
          pull_request_number: pr.number,
          pull_request_url: pr.html_url,
          error: null,
        })
        .where('id', '=', request.id)
        .execute();
      await this.database.db
        .updateTable('capere.scheduled_jobs')
        .set({ enabled: false })
        .where('organization_id', '=', organizationId)
        .where('name', '=', `github-change-execute:${request.id}`)
        .execute();
      return pr;
    } catch (error) {
      await this.database.db
        .updateTable('capere.github_change_requests')
        .set({
          // Leave the command approved so BullMQ can retry it. The branch and
          // content writes use stable names and update semantics.
          status: 'approved',
          branch_name: branch,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        })
        .where('id', '=', request.id)
        .execute();
      throw error;
    }
  }

  private async repository(org: string, id: string) {
    const row = await this.database.db
      .selectFrom('capere.github_repositories')
      .selectAll()
      .where('organization_id', '=', org)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw AppException.notFound(ErrorCode.NOT_FOUND, 'GitHub repository not found');
    return row;
  }
  private async token(installationRowId: string, org: string) {
    const row = await this.database.db
      .selectFrom('capere.github_installations')
      .select('installation_id')
      .where('organization_id', '=', org)
      .where('id', '=', installationRowId)
      .executeTakeFirstOrThrow();
    return (await this.github.installationToken(row.installation_id)).token;
  }
  private validateChange(c: FileChangeDto) {
    if (!this.safePath(c.path) || c.path.startsWith('.github/workflows/'))
      throw AppException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        `Path is not permitted: ${c.path}`,
      );
    if (Buffer.byteLength(c.content) > 1_000_000 || c.content.includes('\0'))
      throw AppException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        `Content is not permitted: ${c.path}`,
      );
  }
  private safePath(p: string) {
    return p.length > 0 && !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\\');
  }
  private extensions(paths: string[]) {
    const out: Record<string, number> = {};
    for (const p of paths) {
      const leaf = p.split('/').pop() ?? '';
      const ext = leaf.includes('.') ? leaf.split('.').pop()!.toLowerCase() : 'none';
      out[ext] = (out[ext] ?? 0) + 1;
    }
    return out;
  }
}
