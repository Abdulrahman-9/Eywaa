import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { toAsciiDigits } from '../common/arabic';
import { Db } from '../db/db.module';
import { FamiliesService } from '../families/families.service';
import { ScoringService } from '../scoring/scoring.service';
import { SettingsService } from '../settings/settings.service';

/** من يُكلَّف بالكشف: المتعهدون والباحثون الميدانيون. */
export const INSPECTOR_ROLES = ['DISTRIBUTION_AGENT', 'FIELD_RESEARCHER'] as const;
/** تكليف لم يُرفع تقريره منذ أكثر من هذا العدد من الأيام يُعلَّم متأخراً. */
export const INSPECTION_LATE_DAYS = 7;

/** بنود المطابقة: هي الوقائع التي تُبنى عليها النقاط، ومعها العنوان والهاتف. */
export const CHECK_KEYS = ['address', 'housing', 'members', 'head', 'income', 'orphans', 'health', 'phone'] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];
const CHECK_LABELS: Record<CheckKey, string> = {
  address: 'العنوان', housing: 'نوع السكن', members: 'عدد الأفراد', head: 'حال العائلة', income: 'الدخل الشهري', orphans: 'الأيتام', health: 'الإعاقة والمرض المزمن', phone: 'الهاتف',
};

const short = (max: number) => z.string().trim().min(1).max(max);
export const candidatesSchema = z.object({
  status: z.enum(['APPROVED', 'PENDING', 'ANY']).default('ANY'),
  state: z.enum(['NONE', 'DONE', 'ANY']).default('NONE'),
  mahalla: short(80).optional(),
  class: z.enum(['A', 'B', 'C', 'D']).optional(),
  /** أرقام عوائل بعينها: تُهمل معها سائر الشروط. */
  familyNos: z.array(z.string().trim().min(2).max(20)).max(500).optional(),
  limit: z.number().int().min(1).max(500).default(50),
});
export const assignSchema = z.object({
  familyIds: z.array(z.string().uuid()).min(1).max(500),
  inspectorIds: z.array(z.string().uuid()).min(1).max(2).refine((v) => new Set(v).size === v.length, 'الكاشفان شخص واحد'),
  /** مع كاشفَين: BOTH يكشف كلٌّ منهما كل عائلة (شهادتان)، SPLIT تُقسم العوائل بينهما. */
  mode: z.enum(['BOTH', 'SPLIT']).default('BOTH'),
  note: short(300).optional(),
});
export const reportSchema = z.object({
  contact: z.enum(['FAMILY', 'OTHERS', 'NONE']),
  checks: z.array(z.object({ key: z.enum(CHECK_KEYS), result: z.enum(['MATCH', 'MISMATCH', 'UNCHECKED']), found: short(200).optional() })).max(CHECK_KEYS.length)
    .refine((v) => new Set(v.map((c) => c.key)).size === v.length, 'بند مكرَّر'),
  notes: short(1000).optional(),
  recommendation: z.enum(['CONFIRM', 'RAISE', 'LOWER', 'REMOVE', 'UNABLE']),
  reason: short(500).optional(),
  visitedAt: z.string().datetime().optional(),
  clientOpId: z.string().uuid().optional(),
});
export const decideSchema = z.object({
  /** APPROVE: يُعتمد الكشف بأثره. REJECT: لا يُعتمد ولا تُعدّ العائلة به مكشوفة. */
  decision: z.enum(['APPROVE', 'REJECT']),
  effect: z.enum(['NONE', 'RAISE', 'LOWER', 'REMOVE']).optional(),
  points: z.number().int().min(1).max(100).optional(),
  /** لعائلة تنتظر الاعتماد: يُعتمد تسجيلها مع اعتماد كشفها، في القرار نفسه. */
  approveFamily: z.boolean().optional(),
  note: short(500).optional(),
});
export const cancelSchema = z.object({ note: z.string().trim().min(3, 'يلزم ذكر السبب').max(300) });
export const listSchema = z.object({
  status: z.enum(['WAITING', 'ASSIGNED', 'DECIDED', 'ALL']).default('ALL'),
  familyId: z.string().uuid().optional(),
  inspectorId: z.string().uuid().optional(),
  q: z.string().trim().optional(),
});
export type AssignInput = z.infer<typeof assignSchema>;
export type ReportInput = z.infer<typeof reportSchema>;
export type DecideInput = z.infer<typeof decideSchema>;

type Q = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
const fmt = (n: number) => n.toLocaleString('en-US');
const HOUSING_AR: Record<string, string> = { OWNED: 'ملك', RENTED: 'إيجار', OTHER: 'أخرى' };
const TAGS_AR: Record<string, string> = { ORPHANS: 'أيتام', WIDOW: 'أرملة', DISABLED: 'معاق', SICK: 'مريض', DIVORCED: 'مطلقة', NEEDY: 'متعفف', UNMARRIED: 'غير متزوجة' };
const INCOME_AR: Record<string, string> = { SALARY: 'راتب', PENSION: 'راتب تقاعدي', SOCIAL_WELFARE: 'رعاية اجتماعية', WORK: 'عمل حر', OTHER_AID: 'إعانة من جهة أخرى' };
const RELATION_AR: Record<string, string> = { HEAD: 'رب الأسرة', SPOUSE: 'الزوج/الزوجة', SON: 'ابن', DAUGHTER: 'ابنة', FATHER: 'الأب', MOTHER: 'الأم', BROTHER: 'أخ', SISTER: 'أخت', OTHER: 'آخر' };
const EFFECT_OF = { CONFIRM: 'NONE', RAISE: 'RAISE', LOWER: 'LOWER', REMOVE: 'REMOVE' } as const;
const count = (n: number, one: string, two: string, few: string, many: string) => (n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`);

/**
 * الكشف الميداني.
 * الكاشف يشهد بما رأى ويوصي؛ والمدير يقرّر الأثر. فلا يغيّر نقاطَ عائلة ولا يشطبها من زارها وحده، ولا من سجّلها.
 * وأثر الكشف في النقاط تعديل محدود يُضاف إلى مجموع المعادلة، يظهر في «لماذا هذه النقاط؟» باسم كشفه.
 */
@Injectable()
export class InspectionsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ScoringService) private readonly scoring: ScoringService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(FamiliesService) private readonly families: FamiliesService,
  ) {}

  // ---------- ما في سجل العائلة ----------

  /** صورة العائلة كما في سجلها الآن: ما يحتاجه الكاشف ليطابق، بلا أرقام وثائق ولا بطاقة تموينية. */
  private async snapshots(q: Q, familyIds: string[]) {
    if (!familyIds.length) return new Map<string, ReturnType<InspectionsService['present']>>();
    const fams = await q.query(
      `select f.id, f.family_no, f.status, f.tags::text[] as tags, f.phone1, f.phone2, f.mahalla, f.street, f.house, f.landmark, f.housing, f.housing_other, f.lat, f.lng,
              f.inspection_delta, f.inspected_at, f.created_by, sc.points, sc.class, sc.base_points
       from families f left join family_scores sc on sc.family_id = f.id where f.id = any($1)`, [familyIds]);
    const persons = await q.query(
      `select family_id, full_name, relation, gender, birth_date, is_orphan, disability, chronic_illness from persons
       where family_id = any($1) and status = 'ACTIVE' order by (relation = 'HEAD') desc, birth_date nulls last`, [familyIds]);
    const incomes = await q.query('select family_id, kind, amount_iqd from income_sources where family_id = any($1)', [familyIds]);
    const out = new Map<string, ReturnType<InspectionsService['present']>>();
    for (const f of fams.rows) out.set(f.id, this.present(f, persons.rows.filter((p) => p.family_id === f.id), incomes.rows.filter((i) => i.family_id === f.id)));
    return out;
  }

  private present(f: any, persons: any[], incomes: any[]) {
    const year = new Date().getFullYear();
    const income = incomes.reduce((s, i) => s + i.amount_iqd, 0);
    const orphans = persons.filter((p) => p.is_orphan).length;
    const disabled = persons.filter((p) => p.disability).length;
    const chronic = persons.filter((p) => p.chronic_illness).length;
    const address = [f.mahalla, f.street, f.house, f.landmark].filter(Boolean).join('، ');
    const health = [disabled && count(disabled, 'معاق واحد', 'معاقان', 'معاقين', 'معاقاً'), chronic && count(chronic, 'مريض مزمن واحد', 'مريضان مزمنان', 'مرضى مزمنين', 'مريضاً مزمناً')].filter(Boolean).join('، ');
    const recorded: Record<CheckKey, string> = {
      address: address || 'لم يُسجَّل عنوان',
      housing: f.housing ? `${HOUSING_AR[f.housing]}${f.housing === 'OTHER' && f.housing_other ? ` (${f.housing_other})` : ''}` : 'لم يُحدَّد',
      members: count(persons.length, 'فرد واحد', 'فردان', 'أفراد', 'فرداً'),
      head: (f.tags as string[]).map((t) => TAGS_AR[t] ?? t).join('، ') || 'بلا وصف خاص',
      income: income ? `${fmt(income)} دينار (${incomes.map((i) => INCOME_AR[i.kind] ?? i.kind).join('، ')})` : 'لا دخل مسجَّل',
      orphans: orphans ? count(orphans, 'يتيم واحد', 'يتيمان', 'أيتام', 'يتيماً') : 'لا أيتام',
      health: health || 'لا إعاقة ولا مرض مزمن',
      phone: [f.phone1, f.phone2].filter(Boolean).join(' · ') || 'لا هاتف',
    };
    return {
      familyId: f.id as string, familyNo: f.family_no as string, status: f.status as string, createdBy: f.created_by as string,
      headName: (persons.find((p) => p.relation === 'HEAD')?.full_name ?? null) as string | null,
      phone: f.phone1 as string | null, mahalla: f.mahalla as string | null, address, location: f.lat != null ? { lat: f.lat as number, lng: f.lng as number } : null,
      members: persons.map((p) => ({
        name: p.full_name as string, relation: RELATION_AR[p.relation] ?? p.relation, gender: p.gender as string, age: p.birth_date ? year - new Date(p.birth_date).getFullYear() : null,
        isOrphan: !!p.is_orphan, disability: p.disability as string | null, chronicIllness: p.chronic_illness as string | null,
      })),
      facts: CHECK_KEYS.map((key) => ({ key, label: CHECK_LABELS[key], recorded: recorded[key] })),
      inspectedAt: f.inspected_at, delta: f.inspection_delta as number,
      score: f.class ? { points: f.points as number, class: f.class as string, base: f.base_points as number } : null,
    };
  }

  // ---------- التكليف ----------

  /** من يُكلَّف بالكشف، وكم على كلٍّ منهم مما لم يرفعه. */
  async inspectors() {
    const { rows } = await this.db.query(
      `select u.id, u.full_name, u.role, u.phone,
              (select count(*) from inspection_reports r join inspections i on i.id = r.inspection_id where r.inspector_id = u.id and r.submitted_at is null and i.status = 'ASSIGNED')::int as open,
              (select count(*) from inspection_reports r where r.inspector_id = u.id and r.submitted_at > now() - interval '30 days')::int as done30
       from users u where u.active and u.role = any($1) order by u.full_name`, [INSPECTOR_ROLES]);
    return rows.map((r) => ({ id: r.id as string, fullName: r.full_name as string, role: r.role as string, phone: r.phone as string | null, open: r.open as number, done30: r.done30 as number }));
  }

  /** عوائل تصلح للتكليف: يُختار منها قبل أن يُكلَّف بها أحد. */
  async candidates(input: z.infer<typeof candidatesSchema>) {
    const nos = input.familyNos?.map((n) => toAsciiDigits(n).replace(/\D/g, '')).filter((n) => n.length >= 2);
    const statuses = input.status === 'APPROVED' ? ['APPROVED'] : input.status === 'PENDING' ? ['PENDING_APPROVAL', 'PENDING_DEDUPE_REVIEW'] : ['APPROVED', 'PENDING_APPROVAL', 'PENDING_DEDUPE_REVIEW'];
    const { rows } = await this.db.query(
      `select f.id, f.family_no, f.status, f.mahalla, f.inspected_at, f.created_at, h.full_name as head_name, sc.class, sc.points,
              (select count(*) from persons p where p.family_id = f.id and p.status = 'ACTIVE')::int as members,
              exists (select 1 from inspections i where i.family_id = f.id and i.status in ('ASSIGNED', 'SUBMITTED')) as inspecting
       from families f left join persons h on h.family_id = f.id and h.relation = 'HEAD' left join family_scores sc on sc.family_id = f.id
       where f.status = any($1::family_status[])
         and case when $2::text[] is not null then f.family_no = any($2)
             else ($3::text is null or f.mahalla ilike '%' || $3 || '%') and ($4::text is null or sc.class = $4)
               and ($5 = 'ANY' or ($5 = 'NONE' and f.inspected_at is null) or ($5 = 'DONE' and f.inspected_at is not null))
               and not exists (select 1 from inspections i where i.family_id = f.id and i.status in ('ASSIGNED', 'SUBMITTED')) end
       order by f.inspected_at nulls first, f.created_at limit $6`,
      [statuses, nos?.length ? nos : null, input.mahalla ?? null, input.class ?? null, input.state, input.limit]);
    const found = new Set(rows.map((r) => r.family_no));
    return {
      families: rows.map((r) => ({
        id: r.id as string, familyNo: r.family_no as string, headName: r.head_name as string | null, mahalla: r.mahalla as string | null, status: r.status as string,
        members: r.members as number, class: r.class as string | null, points: r.points as number | null, inspectedAt: r.inspected_at, inspecting: r.inspecting as boolean, registeredAt: r.created_at,
      })),
      // أرقام كُتبت ولا عائلة قائمة بها.
      unknown: (nos ?? []).filter((n) => !found.has(n)),
    };
  }

  /**
   * التكليف بالكشف. من سجّل العائلة لا يكشفها، وللعائلة كشف قائم واحد.
   * ما لا يصلح من العوائل يُتخطّى بسببه ولا يوقف سائرها.
   */
  async assign(input: AssignInput, actor: AuthUser) {
    return this.db.tx(async (c) => {
      const inspectors = (await c.query('select id, full_name from users where id = any($1) and active and role = any($2)', [input.inspectorIds, INSPECTOR_ROLES])).rows;
      if (inspectors.length !== input.inspectorIds.length) throw new BadRequestException('يُكلَّف بالكشف متعهد أو باحث ميداني عامل');
      // القفل أولاً ثم القراءة بجملة ثانية: لو قُرئ «عليها كشف قائم» في جملة القفل نفسها لرآه مديران متسابقان «لا» معاً،
      // فيُدرج الثاني كشفاً ثانياً ويردّه قيد الفرادة بخطأ خادم.
      await c.query('select 1 from families where id = any($1) order by id for update', [input.familyIds]);
      const fams = (await c.query(
        `select f.id, f.family_no, f.status, f.created_by,
                exists (select 1 from inspections i where i.family_id = f.id and i.status in ('ASSIGNED', 'SUBMITTED')) as inspecting
         from families f where f.id = any($1) order by f.mahalla nulls last, f.family_no`, [input.familyIds])).rows;
      const created: { id: string; no: number; familyNo: string }[] = [];
      const skipped: { familyNo: string; reason: string }[] = [];
      let turn = 0;
      for (const f of fams) {
        if (f.status === 'REJECTED' || f.status === 'REMOVED') { skipped.push({ familyNo: f.family_no, reason: 'مرفوضة أو مشطوبة' }); continue; }
        if (f.inspecting) { skipped.push({ familyNo: f.family_no, reason: 'عليها كشف قائم' }); continue; }
        // مع القسمة يأخذ كلٌّ عائلة بالتناوب؛ فإن كان صاحب الدور هو من سجّلها أخذها الآخر.
        let team = input.inspectorIds;
        if (input.mode === 'SPLIT' && team.length === 2) {
          const first = team[turn % 2], second = team[(turn + 1) % 2];
          team = [first !== f.created_by ? first : second];
          turn++;
        }
        team = team.filter((id) => id !== f.created_by);
        if (!team.length) { skipped.push({ familyNo: f.family_no, reason: 'من سجّل العائلة لا يكشفها' }); continue; }
        const { rows } = await c.query('insert into inspections (family_id, note, requested_by) values ($1,$2,$3) returning id, no', [f.id, input.note ?? null, actor.id]);
        await c.query('insert into inspection_reports (inspection_id, inspector_id) select $1, unnest($2::uuid[])', [rows[0].id, team]);
        await this.audit.append(c, {
          actorId: actor.id, action: 'inspection.assign', entity: 'inspection', entityId: rows[0].id,
          payload: { no: rows[0].no, familyNo: f.family_no, inspectors: team.map((id) => inspectors.find((u) => u.id === id)!.full_name), inspectorIds: team },
        });
        created.push({ id: rows[0].id, no: rows[0].no, familyNo: f.family_no });
      }
      return { created: created.length, inspections: created, skipped };
    });
  }

  /** إلغاء تكليف لم يُفصل فيه: لتبديل الكاشف، أو لأن الكشف لم يعد لازماً. ما رُفع من تقاريره يبقى في السجل. */
  async cancel(id: string, note: string, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const i = (await c.query('select i.*, f.family_no from inspections i join families f on f.id = i.family_id where i.id = $1 for update of i', [id])).rows[0];
      if (!i) throw new NotFoundException('الكشف غير موجود');
      if (i.status !== 'ASSIGNED' && i.status !== 'SUBMITTED') throw new ConflictException('فُصل في هذا الكشف من قبل');
      await c.query("update inspections set status = 'CANCELLED', decision_note = $2 where id = $1", [id, note]);
      await this.audit.append(c, { actorId: actor.id, action: 'inspection.cancel', entity: 'inspection', entityId: id, payload: { no: i.no, familyNo: i.family_no, note } });
    });
    return this.get(id);
  }

  // ---------- تقرير الكاشف ----------

  /** ما على الكاشف كشفه (بصورة العائلة ليطابق)، وما آل إليه آخر ما رفعه. */
  async mine(actor: AuthUser) {
    const pending = await this.db.query(
      `select i.id, i.no, i.note, i.requested_at, i.family_id,
              (select string_agg(u.full_name, '، ') from inspection_reports o join users u on u.id = o.inspector_id where o.inspection_id = i.id and o.inspector_id <> $1) as partner
       from inspection_reports r join inspections i on i.id = r.inspection_id
       where r.inspector_id = $1 and r.submitted_at is null and i.status = 'ASSIGNED' order by i.requested_at limit 300`, [actor.id]);
    const snaps = await this.snapshots(this.db, pending.rows.map((r) => r.family_id));
    const recent = await this.db.query(
      `select i.id, i.no, i.status, i.effect, i.points, i.decision_note, f.family_no, r.recommendation, r.submitted_at, h.full_name as head_name
       from inspection_reports r join inspections i on i.id = r.inspection_id join families f on f.id = i.family_id left join persons h on h.family_id = f.id and h.relation = 'HEAD'
       where r.inspector_id = $1 and r.submitted_at is not null order by r.submitted_at desc limit 30`, [actor.id]);
    return {
      pending: pending.rows.filter((r) => snaps.has(r.family_id)).map((r) => {
        const s = snaps.get(r.family_id)!;
        return {
          id: r.id as string, no: r.no as number, note: r.note as string | null, requestedAt: r.requested_at, partner: r.partner as string | null,
          late: Date.now() - new Date(r.requested_at).getTime() > INSPECTION_LATE_DAYS * 86_400_000,
          family: { familyNo: s.familyNo, headName: s.headName, phone: s.phone, mahalla: s.mahalla, address: s.address, location: s.location, members: s.members, facts: s.facts },
        };
      }),
      recent: recent.rows.map((r) => ({
        id: r.id as string, no: r.no as number, familyNo: r.family_no as string, headName: r.head_name as string | null, recommendation: r.recommendation as string, submittedAt: r.submitted_at,
        status: r.status as string, effect: r.effect as string | null, points: r.points as number | null, decisionNote: r.status === 'REJECTED' ? (r.decision_note as string | null) : null,
      })),
    };
  }

  /** الكاشف يرفع ما وجد. تُحفظ مع كل بند قيمته في السجل ساعةَ الرفع، ليبقى التقرير شاهداً ولو عُدّل السجل بعده. */
  async report(id: string, input: ReportInput, actor: AuthUser) {
    if (input.clientOpId) {
      const prior = (await this.db.query('select inspection_id from inspection_reports where client_op_id = $1', [input.clientOpId])).rows[0];
      if (prior) return this.get(prior.inspection_id, actor);
    }
    const at = input.visitedAt ? new Date(input.visitedAt) : new Date();
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('وقت الزيارة في المستقبل');
    if (input.recommendation !== 'CONFIRM' && !input.reason) {
      throw new BadRequestException(input.recommendation === 'REMOVE' ? 'اكتب سبب طلب الشطب' : input.recommendation === 'UNABLE' ? 'اكتب لماذا تعذّر الكشف' : 'اكتب ما رأيتَه مما يوجب تعديل النقاط');
    }
    for (const c of input.checks) if (c.result === 'MISMATCH' && !c.found) throw new BadRequestException(`اكتب ما وجدتَه في «${CHECK_LABELS[c.key]}»`);
    const verified = input.checks.filter((c) => c.result !== 'UNCHECKED').length;
    if (input.recommendation !== 'UNABLE' && input.recommendation !== 'REMOVE' && !verified) throw new BadRequestException('لم تتحقق من بند واحد: طابق ما رأيتَ، أو علّم أن الكشف تعذّر');
    if (input.contact === 'NONE' && (input.recommendation === 'CONFIRM' || input.recommendation === 'RAISE' || input.recommendation === 'LOWER')) {
      throw new BadRequestException('لم تجد العائلة ولا من يعرفها: علّم أن الكشف تعذّر، أو اطلب شطبها بسببه');
    }
    await this.db.tx(async (c) => {
      const i = (await c.query('select i.*, f.family_no from inspections i join families f on f.id = i.family_id where i.id = $1 for update of i', [id])).rows[0];
      if (!i) throw new NotFoundException('الكشف غير موجود');
      const mine = (await c.query('select id, submitted_at from inspection_reports where inspection_id = $1 and inspector_id = $2 for update', [id, actor.id])).rows[0];
      if (!mine) throw new ForbiddenException('لم تُكلَّف بهذا الكشف');
      if (mine.submitted_at) throw new ConflictException('رفعتَ تقريرك عن هذا الكشف من قبل');
      if (i.status !== 'ASSIGNED') throw new ConflictException(i.status === 'CANCELLED' ? 'أُلغي هذا التكليف' : 'فُصل في هذا الكشف');
      const facts = (await this.snapshots(c, [i.family_id])).get(i.family_id)!.facts;
      const checks = facts.map((f) => {
        const got = input.checks.find((x) => x.key === f.key);
        return { key: f.key, label: f.label, recorded: f.recorded, result: got?.result ?? 'UNCHECKED', found: got?.result === 'MISMATCH' ? got.found : undefined };
      });
      await c.query(
        `update inspection_reports set submitted_at = now(), visited_at = $2, contact = $3, checks = $4, notes = $5, recommendation = $6, reason = $7, client_op_id = $8 where id = $1`,
        [mine.id, at, input.contact, JSON.stringify(checks), input.notes ?? null, input.recommendation, input.reason ?? null, input.clientOpId ?? null]);
      const left = (await c.query('select count(*)::int as n from inspection_reports where inspection_id = $1 and submitted_at is null', [id])).rows[0].n;
      if (!left) await c.query("update inspections set status = 'SUBMITTED' where id = $1", [id]);
      await this.audit.append(c, {
        actorId: actor.id, action: 'inspection.report', entity: 'inspection', entityId: id,
        payload: { no: i.no, familyNo: i.family_no, recommendation: input.recommendation, mismatches: checks.filter((x) => x.result === 'MISMATCH').length, contact: input.contact },
      });
    });
    return this.get(id, actor);
  }

  // ---------- قرار المدير ----------

  /**
   * اعتماد الكشف بأثره، أو ردّه.
   * الأثر: لا شيء، أو رفع النقاط، أو خفضها (في حدّ يضبطه المدير)، أو شطب العائلة.
   * لا يفصل فيه من سجّل العائلة ولا من كشفها؛ وما خالف توصية الكاشفين يلزمه سبب مكتوب.
   */
  async decide(id: string, input: DecideInput, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const i = (await c.query('select * from inspections where id = $1 for update', [id])).rows[0];
      if (!i) throw new NotFoundException('الكشف غير موجود');
      if (i.status !== 'ASSIGNED' && i.status !== 'SUBMITTED') throw new ConflictException('فُصل في هذا الكشف من قبل');
      const reports = (await c.query('select inspector_id, recommendation, reason from inspection_reports where inspection_id = $1 and submitted_at is not null order by submitted_at', [id])).rows;
      if (!reports.length) throw new ConflictException('لم يُرفع تقرير بعد. ألغِ التكليف إن لم يعد لازماً.');
      if (reports.some((r) => r.inspector_id === actor.id)) throw new ForbiddenException('لا يعتمد الكشفَ من قام به');
      const fam = (await c.query('select id, family_no, status, created_by, inspection_delta from families where id = $1 for update', [i.family_id])).rows[0];
      if (fam.created_by === actor.id) throw new ForbiddenException('لا يعتمد كشفَ العائلة من سجّلها');

      if (input.decision === 'REJECT') {
        if (!input.note) throw new BadRequestException('اذكر لماذا لم يُعتمد الكشف');
        await c.query("update inspections set status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1", [id, actor.id, input.note]);
        await this.audit.append(c, { actorId: actor.id, action: 'inspection.reject', entity: 'inspection', entityId: id, payload: { no: i.no, familyNo: fam.family_no, note: input.note } });
        return;
      }
      if (!input.effect) throw new BadRequestException('اختر أثر الكشف');
      if (fam.status === 'REJECTED' || fam.status === 'REMOVED') throw new ConflictException('العائلة مرفوضة أو مشطوبة: لا يُعتمد عليها كشف. ردّه أو ألغِه.');
      const real = reports.filter((r) => r.recommendation !== 'UNABLE');
      if (!real.length && input.effect !== 'REMOVE') throw new ConflictException('تعذّر الكشف على من كُلّف به: لا يُعتمد كأنه وقع. أعد التكليف، أو اشطب العائلة بسبب.');
      // قرار يخالف كل ما أوصى به الكاشفون يلزمه سبب: المدير لم يرَ العائلة.
      const backed = real.some((r) => EFFECT_OF[r.recommendation as keyof typeof EFFECT_OF] === input.effect);
      if (!backed && !input.note) throw new BadRequestException('قرارك يخالف توصية الكاشف: اكتب سببه');

      const before = (await c.query('select points, class from family_scores where family_id = $1', [fam.id])).rows[0] ?? null;
      const deltaBefore: number = fam.inspection_delta;
      let deltaAfter = deltaBefore;
      let effect: 'NONE' | 'RAISED' | 'LOWERED' | 'REMOVED' = 'NONE';
      let points: number | null = null;
      if (input.effect === 'RAISE' || input.effect === 'LOWER') {
        const cap = await this.cap(c);
        if (!input.points) throw new BadRequestException('اكتب عدد النقاط');
        if (input.points > cap) throw new BadRequestException(`أقصى ما يغيّره الكشف ${cap} نقاط`);
        deltaAfter = Math.max(-cap, Math.min(cap, deltaBefore + (input.effect === 'RAISE' ? input.points : -input.points)));
        if (deltaAfter === deltaBefore) throw new ConflictException(`بلغ تعديل الكشف على هذه العائلة حدّه (${deltaBefore > 0 ? 'رفع' : 'خفض'} ${Math.abs(deltaBefore)})`);
        effect = input.effect === 'RAISE' ? 'RAISED' : 'LOWERED';
        points = Math.abs(deltaAfter - deltaBefore);
      }
      let after = before;
      let familyApproved = false;
      if (input.approveFamily && input.effect === 'REMOVE') throw new BadRequestException('لا تُعتمد عائلة وتُشطب في قرار واحد');
      if (input.effect === 'REMOVE') {
        const reason = input.note ?? real.find((r) => r.recommendation === 'REMOVE')?.reason;
        await this.families.removeIn(c, fam.id, `كشف ميداني رقم ${i.no}: ${reason}`, actor);
        effect = 'REMOVED';
        after = null;
      } else {
        await c.query('update families set inspection_delta = $2, inspected_at = now() where id = $1', [fam.id, deltaAfter]);
        if (input.approveFamily) {
          // الكشف شهادة ثانية على السجل: من اعتمده وليس مسجِّلَ العائلة فله أن يعتمد تسجيلها معه. والاعتماد يحسب نقاطها بالتعديل.
          await this.families.approveIn(c, fam.id, `بعد الكشف الميداني رقم ${i.no}`, actor);
          familyApproved = true;
        } else if (deltaAfter !== deltaBefore) {
          await this.scoring.recompute(c, fam.id);
        }
        if (familyApproved || deltaAfter !== deltaBefore) after = (await c.query('select points, class from family_scores where family_id = $1', [fam.id])).rows[0] ?? null;
      }
      await c.query(
        `update inspections set status = 'APPROVED', decided_by = $2, decided_at = now(), decision_note = $3, effect = $4, points = $5, delta_before = $6, delta_after = $7,
                points_before = $8, points_after = $9, class_before = $10, class_after = $11, family_approved = $12 where id = $1`,
        [id, actor.id, input.note ?? null, effect, points, deltaBefore, deltaAfter, before?.points ?? null, after?.points ?? null, before?.class ?? null, after?.class ?? null, familyApproved]);
      await this.audit.append(c, {
        actorId: actor.id, action: 'inspection.approve', entity: 'inspection', entityId: id,
        payload: { no: i.no, familyNo: fam.family_no, effect, points, deltaBefore, deltaAfter, pointsBefore: before?.points ?? null, pointsAfter: after?.points ?? null, familyApproved, note: input.note ?? null },
      });
    });
    return this.get(id);
  }

  private async cap(q: Q): Promise<number> {
    const { rows } = await q.query("select value from settings where key = 'inspection_max_delta'");
    return (rows[0]?.value as number) ?? 0;
  }

  // ---------- العرض ----------

  private static SQL = `
    select i.*, f.family_no, f.status as family_status, f.mahalla, h.full_name as head_name, ru.username as requested_by_username, du.username as decided_by_username,
           (select coalesce(jsonb_agg(jsonb_build_object(
              'id', r.id, 'inspectorId', r.inspector_id, 'inspector', u.full_name, 'role', u.role, 'submittedAt', r.submitted_at, 'visitedAt', r.visited_at, 'contact', r.contact,
              'checks', r.checks, 'notes', r.notes, 'recommendation', r.recommendation, 'reason', r.reason) order by u.full_name), '[]')
            from inspection_reports r join users u on u.id = r.inspector_id where r.inspection_id = i.id) as reports
    from inspections i join families f on f.id = i.family_id left join persons h on h.family_id = f.id and h.relation = 'HEAD'
      join users ru on ru.id = i.requested_by left join users du on du.id = i.decided_by`;

  private row(r: any) {
    const reports = (r.reports as any[]).map((x) => ({
      id: x.id as string, inspectorId: x.inspectorId as string, inspector: x.inspector as string, role: x.role as string, submittedAt: x.submittedAt as string | null, visitedAt: x.visitedAt as string | null,
      contact: x.contact as 'FAMILY' | 'OTHERS' | 'NONE' | null, notes: x.notes as string | null, recommendation: x.recommendation as string | null, reason: x.reason as string | null,
      checks: (x.checks ?? []) as { key: CheckKey; label: string; recorded: string; result: 'MATCH' | 'MISMATCH' | 'UNCHECKED'; found?: string }[],
      mismatches: ((x.checks ?? []) as any[]).filter((c) => c.result === 'MISMATCH').length,
    }));
    const done = reports.filter((x) => x.submittedAt);
    const open = r.status === 'ASSIGNED' || r.status === 'SUBMITTED';
    return {
      id: r.id as string, no: r.no as number, status: r.status as 'ASSIGNED' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED',
      familyId: r.family_id as string, familyNo: r.family_no as string, headName: r.head_name as string | null, mahalla: r.mahalla as string | null, familyStatus: r.family_status as string,
      note: r.note as string | null, requestedBy: r.requested_by_username as string, requestedAt: r.requested_at,
      reports, submitted: done.length, assigned: reports.length,
      // ينتظر قرار المدير: فيه تقرير مرفوع ولم يُفصل فيه.
      waiting: open && done.length > 0,
      late: open && done.length < reports.length && Date.now() - new Date(r.requested_at).getTime() > INSPECTION_LATE_DAYS * 86_400_000,
      // كاشفان رفعا: هل اتفقت توصيتاهما؟
      agreement: done.length === 2 ? (done[0].recommendation === done[1].recommendation ? 'AGREE' : 'DISAGREE') : null,
      decidedBy: r.decided_by_username as string | null, decidedAt: r.decided_at, decisionNote: r.decision_note as string | null,
      effect: r.effect as 'NONE' | 'RAISED' | 'LOWERED' | 'REMOVED' | null, points: r.points as number | null, deltaBefore: r.delta_before as number | null, deltaAfter: r.delta_after as number | null,
      pointsBefore: r.points_before as number | null, pointsAfter: r.points_after as number | null, classBefore: r.class_before as string | null, classAfter: r.class_after as string | null,
      familyApproved: r.family_approved as boolean,
    };
  }

  async list(p: z.infer<typeof listSchema>) {
    const q = p.q?.trim();
    const digits = q ? toAsciiDigits(q).replace(/\D/g, '') : '';
    const { rows } = await this.db.query(
      `${InspectionsService.SQL}
       where ($1::uuid is null or i.family_id = $1)
         and ($2::uuid is null or exists (select 1 from inspection_reports r where r.inspection_id = i.id and r.inspector_id = $2))
         and ($3 = 'ALL'
              or ($3 = 'WAITING' and i.status in ('ASSIGNED', 'SUBMITTED') and exists (select 1 from inspection_reports r where r.inspection_id = i.id and r.submitted_at is not null))
              or ($3 = 'ASSIGNED' and i.status = 'ASSIGNED' and not exists (select 1 from inspection_reports r where r.inspection_id = i.id and r.submitted_at is not null))
              or ($3 = 'DECIDED' and i.status in ('APPROVED', 'REJECTED', 'CANCELLED')))
         and ($4::text is null or f.family_no = $5 or i.no::text = $5 or h.full_name ilike '%' || $4 || '%' or f.mahalla ilike '%' || $4 || '%')
       order by case when i.status in ('ASSIGNED', 'SUBMITTED') then i.requested_at end, coalesce(i.decided_at, i.requested_at) desc limit 300`,
      [p.familyId ?? null, p.inspectorId ?? null, p.status, q || null, digits || null]);
    return rows.map((r) => this.row(r));
  }

  /** الكشف بتفصيله، ومعه صورة العائلة الآن وما يلزم لمعاينة أثر القرار قبل اتخاذه. الكاشف لا يرى منه إلا تقريره. */
  async get(id: string, viewer?: AuthUser) {
    const r = (await this.db.query(`${InspectionsService.SQL} where i.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException('الكشف غير موجود');
    const row = this.row(r);
    if (viewer && (INSPECTOR_ROLES as readonly string[]).includes(viewer.role)) {
      const mine = row.reports.find((x) => x.inspectorId === viewer.id);
      if (!mine) throw new ForbiddenException('لم تُكلَّف بهذا الكشف');
      return { id: row.id, no: row.no, status: row.status, familyNo: row.familyNo, report: mine };
    }
    const family = (await this.snapshots(this.db, [row.familyId])).get(row.familyId)!;
    const scale = await this.scoring.scale();
    return { ...row, family, cap: await this.cap(this.db), thresholds: scale.thresholds, maxPoints: scale.max };
  }

  /** أرقام الكشف: كم كُشف، وكم ينتظر، وكم غيّر الكشف من حال العوائل. */
  async summary() {
    const fam = (await this.db.query(
      `select count(*)::int as total, count(*) filter (where inspected_at is not null)::int as inspected,
              count(*) filter (where exists (select 1 from inspections i where i.family_id = f.id and i.status in ('ASSIGNED', 'SUBMITTED')))::int as open,
              count(*) filter (where inspection_delta > 0)::int as raised_now, count(*) filter (where inspection_delta < 0)::int as lowered_now
       from families f where f.status in ('APPROVED', 'PENDING_APPROVAL', 'PENDING_DEDUPE_REVIEW')`)).rows[0];
    const ins = (await this.db.query(
      `select count(*) filter (where i.status in ('ASSIGNED', 'SUBMITTED') and exists (select 1 from inspection_reports r where r.inspection_id = i.id and r.submitted_at is not null))::int as waiting,
              count(*) filter (where i.status = 'ASSIGNED' and not exists (select 1 from inspection_reports r where r.inspection_id = i.id and r.submitted_at is not null))::int as assigned,
              count(*) filter (where i.status = 'ASSIGNED' and i.requested_at < now() - make_interval(days => ${INSPECTION_LATE_DAYS}))::int as late,
              min(i.requested_at) filter (where i.status = 'ASSIGNED') as oldest,
              count(*) filter (where i.status = 'APPROVED')::int as approved, count(*) filter (where i.status = 'REJECTED')::int as rejected,
              count(*) filter (where i.effect = 'NONE')::int as none, count(*) filter (where i.effect = 'RAISED')::int as raised,
              count(*) filter (where i.effect = 'LOWERED')::int as lowered, count(*) filter (where i.effect = 'REMOVED')::int as removed
       from inspections i`)).rows[0];
    const rep = (await this.db.query(
      `select count(*)::int as submitted,
              count(*) filter (where exists (select 1 from jsonb_array_elements(r.checks) c where c->>'result' = 'MISMATCH'))::int as with_mismatch
       from inspection_reports r where r.submitted_at is not null`)).rows[0];
    const pairs = (await this.db.query(
      `select count(*)::int as total, count(*) filter (where n = 1)::int as agreed from (
         select count(distinct r.recommendation) as n from inspection_reports r where r.submitted_at is not null group by r.inspection_id having count(*) = 2) x`)).rows[0];
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    return {
      families: { total: fam.total as number, inspected: fam.inspected as number, open: fam.open as number, never: fam.total - fam.inspected, raisedNow: fam.raised_now as number, loweredNow: fam.lowered_now as number },
      inspectedPercent: pct(fam.inspected, fam.total),
      waiting: ins.waiting as number, assigned: ins.assigned as number, late: ins.late as number,
      oldestDays: ins.oldest ? Math.floor((Date.now() - new Date(ins.oldest).getTime()) / 86_400_000) : null,
      decided: { approved: ins.approved as number, rejected: ins.rejected as number, none: ins.none as number, raised: ins.raised as number, lowered: ins.lowered as number, removed: ins.removed as number },
      // من كل مئة كشف معتمد، كم غيّر حال عائلته.
      changedPercent: pct(ins.raised + ins.lowered + ins.removed, ins.approved),
      reports: { submitted: rep.submitted as number, withMismatch: rep.with_mismatch as number, mismatchPercent: pct(rep.with_mismatch, rep.submitted) },
      double: { total: pairs.total as number, agreed: pairs.agreed as number, agreedPercent: pct(pairs.agreed, pairs.total) },
      cap: await this.cap(this.db), lateDays: INSPECTION_LATE_DAYS,
    };
  }
}
