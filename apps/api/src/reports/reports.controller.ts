import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { Db } from '../db/db.module';
import { donorSchema, DonorsService } from '../donors/donors.service';
import { ReportsService } from './reports.service';

const READERS = ['ADMIN', 'ACCOUNTANT', 'DISTRIBUTION_MANAGER', 'BENEFICIARY_SUPERVISOR', 'AUDITOR'] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function sendCsv(res: Response, name: string, csv: string) {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.csv`,
    'Cache-Control': 'private, no-store',
  });
  res.end(csv);
}

@Controller()
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(DonorsService) private readonly donors: DonorsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(Db) private readonly db: Db,
  ) {}

  // ---------- المتبرعون ----------

  @Get('donors')
  @Roles('ADMIN', 'ACCOUNTANT', 'STOREKEEPER', 'AUDITOR')
  donorsList() {
    return this.donors.list();
  }

  @Post('donors')
  @Roles('ADMIN', 'ACCOUNTANT')
  createDonor(@Body(new ZodPipe(donorSchema)) body: z.infer<typeof donorSchema>, @CurrentUser() user: AuthUser) {
    return this.donors.create(body, user);
  }

  @Get('donors/:id/report')
  @Roles('ADMIN', 'ACCOUNTANT', 'AUDITOR')
  donorReport(@Param('id', ParseUUIDPipe) id: string) {
    return this.donors.report(id);
  }

  // ---------- التقارير ----------

  @Get('reports/monthly')
  @Roles(...READERS)
  monthly() {
    return this.reports.monthly();
  }

  @Get('reports/stale')
  @Roles(...READERS)
  stale(@Query('months') months?: string) {
    return this.reports.stale(Math.min(Math.max(Number(months) || 12, 1), 120));
  }

  @Get('reports/staff')
  @Roles('ADMIN', 'AUDITOR')
  staff(@Query(new ZodPipe(z.object({ from: date, to: date }))) q: { from: string; to: string }) {
    return this.reports.staff(q.from, q.to);
  }

  /** تصدير أسماء العوائل وهواتفها يُسجَّل باسم مصدّره. */
  @Get('reports/families.csv')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'AUDITOR')
  async familiesCsv(@Query(new ZodPipe(z.object({ class: z.enum(['A', 'B', 'C', 'D']).optional(), status: z.enum(['APPROVED', 'PENDING_APPROVAL', 'PENDING_DEDUPE_REVIEW', 'REJECTED', 'REMOVED']).optional() }))) q: { class?: string; status?: string }, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const csv = await this.reports.familiesCsv(q);
    await this.db.tx((c) => this.audit.append(c, { actorId: user.id, action: 'report.export', entity: 'report', entityId: 'families', payload: { ...q, rows: csv.split('\r\n').length - 2 } }));
    sendCsv(res, 'العوائل', csv);
  }

  @Get('reports/campaign/:id.csv')
  @Roles('ADMIN', 'DISTRIBUTION_MANAGER', 'ACCOUNTANT', 'AUDITOR')
  async campaignCsv(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const { name, csv } = await this.reports.campaignCsv(id);
    await this.db.tx((c) => this.audit.append(c, { actorId: user.id, action: 'report.export', entity: 'report', entityId: `campaign:${id}`, payload: { rows: csv.split('\r\n').length - 2 } }));
    sendCsv(res, `كشف التسليم - ${name}`, csv);
  }
}
