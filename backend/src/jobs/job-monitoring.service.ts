import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../shared/database';
@Injectable()
export class JobMonitoringService {
  constructor(private readonly database: DatabaseService) {}
  list(organizationId: string, status?: 'failed' | 'dead_lettered') {
    let query = this.database.db
      .selectFrom('capere.job_runs')
      .selectAll()
      .where('organization_id', '=', organizationId);
    if (status) query = query.where('status', '=', status);
    return query.orderBy('created_at', 'desc').limit(100).execute();
  }
  async retry(organizationId: string, id: string) {
    return this.database.db
      .updateTable('capere.job_runs')
      .set({
        status: 'failed',
        attempts: 0,
        next_retry_at: new Date(),
        error: null,
        finished_at: null,
        claimed_by: null,
        lease_until: null,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .where('status', 'in', ['failed', 'dead_lettered'])
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
