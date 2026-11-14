import { Controller, Get, Inject } from '@nestjs/common';
import { AnyRole } from '../auth/auth.guard';
import { Db } from '../db/db.module';

/** أرقام مجملة للصفحة الرئيسية. لا أسماء فيها ولا وثائق، فتُتاح لكل من سجّل دخوله. */
@Controller('stats')
export class StatsController {
  constructor(@Inject(Db) private readonly db: Db) {}

  @Get('overview')
  @AnyRole()
  async overview() {
    const { rows } = await this.db.query(`
      select
        (select count(*) from families where status = 'APPROVED')::int as approved,
        (select count(*) from families where status = 'PENDING_APPROVAL')::int as pending_approval,
        (select count(*) from families where status = 'PENDING_DEDUPE_REVIEW')::int as pending_dedupe,
        (select count(*) from families where status = 'REJECTED')::int as rejected,
        (select count(*) from persons p join families f on f.id = p.family_id
           where f.status = 'APPROVED' and p.status = 'ACTIVE')::int as persons,
        (select count(*) from duplicate_flags where status = 'OPEN')::int as open_flags,
        (select count(*) from change_requests where status = 'PENDING')::int as pending_changes,
        (select value from settings where key = 'poverty_line_iqd') as poverty_line
    `);
    const r = rows[0];
    return {
      families: {
        approved: r.approved, pendingApproval: r.pending_approval,
        pendingDedupeReview: r.pending_dedupe, rejected: r.rejected,
      },
      approvedPersons: r.persons,
      openDuplicateFlags: r.open_flags,
      pendingChangeRequests: r.pending_changes,
      povertyLineIqd: r.poverty_line,
    };
  }
}
