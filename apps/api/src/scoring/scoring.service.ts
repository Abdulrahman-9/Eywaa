import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { Db } from '../db/db.module';
import { SettingsService } from '../settings/settings.service';
import { adjust, computeScore, Criteria, criteriaSchema, Facts, maxTotal, Score, Thresholds, thresholdsSchema } from './formula';

type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

/** وقائع العوائل المعتمدة كلها في استعلام واحد. */
const FACTS_SQL = `
  select f.id, f.family_no, f.housing, f.inspection_delta,
         (f.tags::text[] && array['WIDOW','DIVORCED','UNMARRIED']) as female_head,
         coalesce((select sum(amount_iqd) from income_sources i where i.family_id = f.id), 0)::int as income,
         count(p.id) filter (where p.status = 'ACTIVE')::int as members,
         count(p.id) filter (where p.status = 'ACTIVE' and p.is_orphan)::int as orphans,
         count(p.id) filter (where p.status = 'ACTIVE' and p.disability is not null)::int as disabled,
         count(p.id) filter (where p.status = 'ACTIVE' and p.chronic_illness is not null)::int as chronic
  from families f left join persons p on p.family_id = f.id
  where f.status = 'APPROVED' and ($1::uuid is null or f.id = $1)
  group by f.id`;

const toFacts = (r: any): Facts => ({
  members: r.members, monthlyIncomeIqd: r.income, orphans: r.orphans, disabled: r.disabled, chronic: r.chronic,
  housing: r.housing, femaleHeadNoProvider: r.female_head,
});

@Injectable()
export class ScoringService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  private async active(q: Queryable): Promise<{ version: number; criteria: Criteria; thresholds: Thresholds }> {
    const { rows } = await q.query("select version, criteria, thresholds from scoring_versions where status = 'ACTIVE'");
    if (!rows[0]) throw new NotFoundException('لا إصدار سارٍ لمعادلة النقاط');
    return rows[0];
  }

  private async povertyLine(q: Queryable): Promise<number> {
    const { rows } = await q.query("select value from settings where key = 'poverty_line_iqd'");
    return rows[0].value as number;
  }

  /** يحسب نقاط عائلة واحدة أو العوائل المعتمدة كلها بالإصدار الساري، ويحفظها. */
  async recompute(q: Queryable, familyId: string | null = null): Promise<number> {
    const v = await this.active(q);
    const line = await this.povertyLine(q);
    const { rows } = await q.query(FACTS_SQL, [familyId]);
    if (!rows.length) return 0;
    const max = maxTotal(v.criteria);
    // مجموع المعادلة، ثم تعديل الكشف الميداني المعتمَد على العائلة إن وُجد.
    const scores = rows.map((r) => ({ id: r.id as string, ...adjust(computeScore(toFacts(r), v.criteria, v.thresholds, line), r.inspection_delta, v.thresholds, max) }));
    await q.query(
      `insert into family_scores (family_id, version, points, class, breakdown, base_points, adjustment, computed_at)
       select x.id, $1, x.points, x.class, x.breakdown, x.base, x.adjustment, now()
       from unnest($2::uuid[], $3::int[], $4::text[], $5::jsonb[], $6::int[], $7::int[]) as x(id, points, class, breakdown, base, adjustment)
       on conflict (family_id) do update
         set version = excluded.version, points = excluded.points, class = excluded.class,
             breakdown = excluded.breakdown, base_points = excluded.base_points, adjustment = excluded.adjustment, computed_at = now()`,
      [v.version, scores.map((s) => s.id), scores.map((s) => s.points), scores.map((s) => s.class), scores.map((s) => JSON.stringify(s.breakdown)),
       scores.map((s) => s.base), scores.map((s) => s.adjustment)],
    );
    return scores.length;
  }

  async recomputeAll(): Promise<{ families: number; ms: number }> {
    const t0 = Date.now();
    const families = await this.db.tx((c) => this.recompute(c));
    return { families, ms: Date.now() - t0 };
  }

  async familyScore(familyId: string) {
    const { rows } = await this.db.query('select version, points, class, breakdown, base_points, adjustment, computed_at from family_scores where family_id = $1', [familyId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { version: r.version, points: r.points, class: r.class, breakdown: r.breakdown, base: r.base_points, adjustment: r.adjustment, computedAt: r.computed_at };
  }

  /** ما يلزم لمعاينة أثر تعديل قبل اعتماده: حدود الفئات، وأقصى المعادلة. */
  async scale(q: Queryable = this.db) {
    const v = await this.active(q);
    return { thresholds: v.thresholds, max: maxTotal(v.criteria) };
  }

  async overview() {
    const versions = await this.db.query(
      `select v.version, v.status, v.criteria, v.thresholds, v.note, v.created_at, v.decided_at, v.decision_note,
              cu.username as created_by, du.username as decided_by
       from scoring_versions v left join users cu on cu.id = v.created_by left join users du on du.id = v.decided_by
       order by v.version desc`,
    );
    const classes = await this.db.query('select class, count(*)::int as n from family_scores group by class');
    const counts = { A: 0, B: 0, C: 0, D: 0 } as Record<string, number>;
    for (const r of classes.rows) counts[r.class] = r.n;
    const list = versions.rows.map((v) => ({
      version: v.version, status: v.status, criteria: v.criteria, thresholds: v.thresholds, note: v.note,
      maxTotal: maxTotal(v.criteria), createdBy: v.created_by, createdAt: v.created_at,
      decidedBy: v.decided_by, decidedAt: v.decided_at, decisionNote: v.decision_note,
    }));
    return {
      active: list.find((v) => v.status === 'ACTIVE') ?? null,
      pending: list.find((v) => v.status === 'PENDING') ?? null,
      history: list,
      classes: counts,
      povertyLineIqd: await this.settings.get<number>('poverty_line_iqd'),
    };
  }

  private parse(body: { criteria?: unknown; thresholds?: unknown }) {
    const criteria = criteriaSchema.safeParse(body.criteria);
    const thresholds = thresholdsSchema.safeParse(body.thresholds);
    if (!criteria.success || !thresholds.success) {
      const issues = [...(criteria.error?.issues ?? []), ...(thresholds.error?.issues ?? [])];
      throw new BadRequestException({ message: 'قيم المعادلة غير صالحة', errors: issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (thresholds.data.a > maxTotal(criteria.data)) {
      throw new BadRequestException('حدّ الفئة أ أعلى من أقصى مجموع تبلغه المعايير، فلا تبلغها عائلة');
    }
    return { criteria: criteria.data, thresholds: thresholds.data };
  }

  /** أثر معادلة مقترحة على العوائل المعتمدة، دون أن يُحفظ شيء. */
  async simulate(body: { criteria?: unknown; thresholds?: unknown }) {
    const draft = this.parse(body);
    const line = await this.povertyLine(this.db);
    const { rows } = await this.db.query(
      `select x.*, s.class as old_class, s.points as old_points, h.full_name as head_name
       from (${FACTS_SQL}) x left join family_scores s on s.family_id = x.id
         left join persons h on h.family_id = x.id and h.relation = 'HEAD'`,
      [null],
    );
    const transitions: Record<string, number> = {};
    const after = { A: 0, B: 0, C: 0, D: 0 } as Record<string, number>;
    const affected: { familyId: string; familyNo: string; headName: string; from: string; to: string; oldPoints: number; newPoints: number }[] = [];
    for (const r of rows) {
      const next: Score = adjust(computeScore(toFacts(r), draft.criteria, draft.thresholds, line), r.inspection_delta, draft.thresholds, maxTotal(draft.criteria));
      after[next.class]++;
      const from = r.old_class ?? next.class;
      if (from !== next.class) {
        transitions[`${from}>${next.class}`] = (transitions[`${from}>${next.class}`] ?? 0) + 1;
        if (affected.length < 200) {
          affected.push({ familyId: r.id, familyNo: r.family_no, headName: r.head_name, from, to: next.class, oldPoints: r.old_points ?? next.points, newPoints: next.points });
        }
      }
    }
    const changed = Object.values(transitions).reduce((a, b) => a + b, 0);
    return { families: rows.length, changed, transitions, after, affected, maxTotal: maxTotal(draft.criteria) };
  }

  async propose(body: { criteria?: unknown; thresholds?: unknown; note?: string }, actor: AuthUser) {
    const draft = this.parse(body);
    try {
      const version = await this.db.tx(async (c) => {
        const next = await c.query('select coalesce(max(version), 0) + 1 as v from scoring_versions');
        const v: number = next.rows[0].v;
        await c.query(
          "insert into scoring_versions (version, status, criteria, thresholds, note, created_by) values ($1, 'PENDING', $2, $3, $4, $5)",
          [v, JSON.stringify(draft.criteria), JSON.stringify(draft.thresholds), body.note?.trim() || null, actor.id],
        );
        await this.audit.append(c, { actorId: actor.id, action: 'scoring.propose', entity: 'scoring_version', entityId: String(v), payload: draft });
        return v;
      });
      return { version };
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('في الانتظار إصدار لم يُفصل فيه. افصل فيه أولاً.');
      throw err;
    }
  }

  /** اعتماد الإصدار يجعله سارياً ويعيد حساب نقاط العوائل كلها في المعاملة نفسها. */
  async decide(version: number, approve: boolean, note: string | undefined, actor: AuthUser) {
    return this.db.tx(async (c) => {
      const { rows } = await c.query('select status, created_by from scoring_versions where version = $1 for update', [version]);
      const v = rows[0];
      if (!v) throw new NotFoundException('الإصدار غير موجود');
      if (v.status !== 'PENDING') throw new ConflictException('فُصل في هذا الإصدار من قبل');
      if (v.created_by === actor.id) throw new ForbiddenException('لا يعتمد الموظف إصداراً اقترحه بنفسه');
      if (!approve && !note) throw new BadRequestException('يلزم ذكر سبب الرفض');
      let recomputed = 0;
      if (approve) {
        await c.query("update scoring_versions set status = 'RETIRED' where status = 'ACTIVE'");
        await c.query("update scoring_versions set status = 'ACTIVE', decided_by = $2, decided_at = now(), decision_note = $3 where version = $1", [version, actor.id, note ?? null]);
        recomputed = await this.recompute(c);
      } else {
        await c.query("update scoring_versions set status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3 where version = $1", [version, actor.id, note]);
      }
      await this.audit.append(c, {
        actorId: actor.id, action: approve ? 'scoring.approve' : 'scoring.reject', entity: 'scoring_version', entityId: String(version),
        payload: { note: note ?? null, recomputed },
      });
      return { version, status: approve ? 'ACTIVE' : 'REJECTED', recomputed };
    });
  }
}
