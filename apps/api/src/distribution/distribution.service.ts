import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { toAsciiDigits } from '../common/arabic';
import { FieldCrypto } from '../common/crypto';
import { Config } from '../config';
import { CONFIG, Db } from '../db/db.module';
import { NotificationsService } from '../notifications/notifications.service';
import { ProgramsService } from '../programs/programs.service';
import { laneOf, Manifest } from './offline';
import { TokenSigner, verifyToken } from './token';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const campaignSchema = z.object({
  name: z.string().trim().min(3).max(120),
  programId: z.string().uuid(),
  startsOn: date,
  endsOn: date,
  pointIds: z.array(z.string().uuid()).min(1).max(50),
}).refine((c) => c.endsOn >= c.startsOn, 'تاريخ النهاية قبل البداية');
export type CampaignInput = z.infer<typeof campaignSchema>;

const locator = z.union([
  z.object({ token: z.string().min(10).max(1000) }),
  z.object({ campaignId: z.string().uuid(), familyNo: z.string().min(1), code: z.string().min(4).max(20) }),
]);
const station = { pointId: z.string().uuid(), deviceId: z.string().trim().min(1).max(64) };
export const checkSchema = z.object({ ...station, locate: locator });
export const redeemSchema = z.object({
  ...station, locate: locator, clientOpId: z.string().uuid(),
  receiver: z.union([z.object({ kind: z.literal('HEAD') }), z.object({ kind: z.literal('PROXY'), proxyId: z.string().uuid() })]),
});
export const syncSchema = z.object({
  ...station,
  items: z.array(z.object({
    entitlementId: z.string().uuid(), deliveredAt: z.string().datetime(), clientOpId: z.string().uuid(),
    receiver: z.enum(['HEAD', 'PROXY']), receiverName: z.string().trim().min(1).max(200),
  })).max(2000),
});
export type CheckInput = z.infer<typeof checkSchema>;
export type RedeemInput = z.infer<typeof redeemSchema>;
export type SyncInput = z.infer<typeof syncSchema>;

type IncidentKind = 'ALREADY_DELIVERED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'NOT_ACTIVE' | 'CANCELLED' | 'WRONG_POINT_OFFLINE' | 'DOUBLE_DELIVERY' | 'BAD_CODE';
const MESSAGES: Record<IncidentKind, string> = {
  ALREADY_DELIVERED: 'لا تسلّم: هذا الرمز استُعمل من قبل',
  BAD_SIGNATURE: 'لا تسلّم: رمز غير صحيح أو مزوَّر',
  BAD_CODE: 'لا تسلّم: رقم العائلة أو الرمز الرقمي غير صحيح',
  EXPIRED: 'لا تسلّم: انتهت مدة الحملة',
  NOT_ACTIVE: 'لا تسلّم: الحملة ليست جارية',
  CANCELLED: 'لا تسلّم: أُلغي هذا الاستحقاق',
  WRONG_POINT_OFFLINE: 'سُلِّم دون اتصال في غير نقطته',
  DOUBLE_DELIVERY: 'سُلِّم مرتين',
};

const ENT_SQL = `
  select e.*, c.name as campaign_name, c.status as campaign_status, c.ends_on, c.unit, c.program_id,
         f.family_no, h.full_name as head_name, ap.name as assigned_point_name, dp.name as delivered_point_name
  from entitlements e join campaigns c on c.id = e.campaign_id join families f on f.id = e.family_id
    left join persons h on h.family_id = f.id and h.relation = 'HEAD'
    join distribution_points ap on ap.id = e.point_id left join distribution_points dp on dp.id = e.delivered_point`;

const INVITE = 'السلام عليكم {الاسم}. مستحقاتكم ({المقدار}) بانتظاركم في نقطة {النقطة} حتى {آخر_موعد}. أحضروا هذا الرمز: {الرمز_الرقمي}. رقم العائلة: {رقم_العائلة}';

interface Station { actor: AuthUser; pointId: string; deviceId: string }

/** معرّف الحملة كما يدّعيه رمز لم يصحّ توقيعه. يُستعمل للبلاغ فقط، ولا يوثق به. */
function claimedCampaign(token: string): string | undefined {
  try {
    const c = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')).c;
    return typeof c === 'string' && /^[0-9a-f-]{36}$/i.test(c) ? c : undefined;
  } catch {
    return undefined;
  }
}

class Refusal extends Error {
  constructor(readonly kind: IncidentKind, readonly row: { id?: string; campaign_id?: string } | null, readonly details: Record<string, unknown>) {
    super(kind);
  }
}

@Injectable()
export class DistributionService {
  private readonly signer: TokenSigner;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) config: Config,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProgramsService) private readonly programs: ProgramsService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {
    this.signer = new TokenSigner(config.TOKEN_SIGNING_SEED);
  }

  // ---------- نقاط التوزيع ----------

  async points() {
    const { rows } = await this.db.query('select id, name, active from distribution_points order by name');
    return rows;
  }

  async createPoint(name: string, actor: AuthUser) {
    try {
      return await this.db.tx(async (c) => {
        const { rows } = await c.query('insert into distribution_points (name) values ($1) returning id, name, active', [name]);
        await this.audit.append(c, { actorId: actor.id, action: 'point.create', entity: 'point', entityId: rows[0].id, payload: { name } });
        return rows[0];
      });
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('نقطة بهذا الاسم موجودة');
      throw err;
    }
  }

  // ---------- الحملات ----------

  /** ينشئ مسودة حملة: قائمة المستحقين تؤخذ من قواعد البرنامج لحظة الإنشاء، وتُوزَّع على النقاط بالتساوي. */
  async create(input: CampaignInput, actor: AuthUser) {
    const program = await this.programs.get(input.programId);
    if (!program.active) throw new ConflictException('البرنامج معطَّل');
    const points = await this.db.query('select id from distribution_points where id = any($1) and active', [input.pointIds]);
    if (points.rowCount !== new Set(input.pointIds).size) throw new BadRequestException('في النقاط المختارة نقطة غير موجودة أو معطَّلة');

    const eligible = await this.programs.eligible(program);
    // يُستثنى من استلم من البرنامج نفسه قريباً، ومن له استحقاق قائم في حملة أخرى للبرنامج.
    const busy = await this.db.query(
      `select distinct e.family_id from entitlements e join campaigns c on c.id = e.campaign_id
       where c.program_id = $1 and (
         (e.status = 'DELIVERED' and e.delivered_at > now() - make_interval(days => $2))
         or (e.status = 'PENDING' and c.status in ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE')))`,
      [program.id, program.minGapDays],
    );
    const skip = new Set(busy.rows.map((r) => r.family_id));
    const list = eligible.filter((e) => !skip.has(e.familyId));
    if (!list.length) throw new ConflictException('لا عائلة تستحق هذا البرنامج الآن');

    const id = await this.db.tx(async (c) => {
      const { rows } = await c.query(
        'insert into campaigns (name, program_id, unit, starts_on, ends_on, created_by) values ($1,$2,$3,$4,$5,$6) returning id',
        [input.name, program.id, program.unit, input.startsOn, input.endsOn, actor.id],
      );
      await c.query(
        `insert into entitlements (campaign_id, family_id, point_id, serial, quantity)
         select $1, x.family_id, x.point_id, x.serial, x.quantity
         from unnest($2::uuid[], $3::uuid[], $4::int[], $5::int[]) as x(family_id, point_id, serial, quantity)`,
        [rows[0].id, list.map((e) => e.familyId), list.map((_, i) => input.pointIds[i % input.pointIds.length]), list.map((_, i) => i + 1), list.map((e) => e.quantity)],
      );
      await this.audit.append(c, {
        actorId: actor.id, action: 'campaign.create', entity: 'campaign', entityId: rows[0].id,
        payload: { name: input.name, program: program.name, families: list.length, quantity: list.reduce((s, e) => s + e.quantity, 0), excluded: eligible.length - list.length },
      });
      return rows[0].id as string;
    });
    return this.detail(id);
  }

  async list() {
    const { rows } = await this.db.query(
      `select c.id, c.name, c.status, c.unit, c.starts_on, c.ends_on, p.name as program,
              count(e.id)::int as families, count(e.id) filter (where e.status = 'DELIVERED')::int as delivered,
              coalesce(sum(e.quantity), 0)::int as quantity
       from campaigns c join programs p on p.id = c.program_id left join entitlements e on e.campaign_id = c.id
       group by c.id, p.name order by c.created_at desc`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, unit: r.unit, startsOn: r.starts_on, endsOn: r.ends_on, program: r.program, families: r.families, delivered: r.delivered, quantity: r.quantity }));
  }

  async detail(id: string) {
    const head = await this.db.query(
      `select c.*, p.name as program, cu.username as created_by_username, du.username as decided_by_username
       from campaigns c join programs p on p.id = c.program_id join users cu on cu.id = c.created_by left join users du on du.id = c.decided_by
       where c.id = $1`,
      [id],
    );
    const c = head.rows[0];
    if (!c) throw new NotFoundException('الحملة غير موجودة');
    const [points, recent, incidents, proxy] = await Promise.all([
      this.db.query(
        `select dp.id, dp.name, count(e.id)::int as assigned, coalesce(sum(e.quantity), 0)::int as quantity,
                count(e.id) filter (where e.status = 'DELIVERED')::int as delivered,
                coalesce(sum(e.quantity) filter (where e.status = 'DELIVERED'), 0)::int as delivered_quantity,
                max(e.delivered_at) as last_delivery
         from entitlements e join distribution_points dp on dp.id = e.point_id where e.campaign_id = $1 group by dp.id order by dp.name`,
        [id],
      ),
      this.db.query(
        `select e.id, f.id as family_id, f.family_no, e.receiver, e.receiver_name, e.quantity, e.delivered_at, e.mode, dp.name as point, u.username,
                e.proof_attachment is not null as has_proof
         from entitlements e join families f on f.id = e.family_id left join distribution_points dp on dp.id = e.delivered_point
           left join users u on u.id = e.delivered_by
         where e.campaign_id = $1 and e.status = 'DELIVERED' order by e.delivered_at desc limit 20`,
        [id],
      ),
      this.db.query(
        `select i.id, i.kind, i.at, i.details, i.device_id, dp.name as point, u.username, f.family_no
         from delivery_incidents i left join distribution_points dp on dp.id = i.point_id join users u on u.id = i.reported_by
           left join entitlements e on e.id = i.entitlement_id left join families f on f.id = e.family_id
         where i.campaign_id = $1 order by i.at desc limit 30`,
        [id],
      ),
      this.db.query("select count(*)::int as n from entitlements where campaign_id = $1 and status = 'DELIVERED' and receiver = 'PROXY'", [id]),
    ]);
    const sum = (key: string) => points.rows.reduce((s, r) => s + r[key], 0);
    return {
      id: c.id, name: c.name, status: c.status, unit: c.unit, program: c.program, startsOn: c.starts_on, endsOn: c.ends_on,
      createdBy: c.created_by_username, createdAt: c.created_at, decidedBy: c.decided_by_username, decidedAt: c.decided_at, decisionNote: c.decision_note,
      totals: { families: sum('assigned'), quantity: sum('quantity'), delivered: sum('delivered'), deliveredQuantity: sum('delivered_quantity'), byProxy: proxy.rows[0].n },
      points: points.rows.map((r) => ({ id: r.id, name: r.name, assigned: r.assigned, quantity: r.quantity, delivered: r.delivered, deliveredQuantity: r.delivered_quantity, lastDelivery: r.last_delivery })),
      recent: recent.rows.map((r) => ({ id: r.id, familyId: r.family_id, familyNo: r.family_no, receiver: r.receiver, receiverName: r.receiver_name, quantity: r.quantity, deliveredAt: r.delivered_at, mode: r.mode, point: r.point, by: r.username, hasProof: r.has_proof })),
      incidents: incidents.rows.map((r) => ({ id: r.id, kind: r.kind, message: MESSAGES[r.kind as IncidentKind], at: r.at, details: r.details, deviceId: r.device_id, point: r.point, by: r.username, familyNo: r.family_no })),
    };
  }

  private async transition(id: string, actor: AuthUser, from: string[], fn: (c: PoolClient, row: any) => Promise<void>) {
    await this.db.tx(async (c) => {
      const { rows } = await c.query('select * from campaigns where id = $1 for update', [id]);
      if (!rows[0]) throw new NotFoundException('الحملة غير موجودة');
      if (!from.includes(rows[0].status)) throw new ConflictException('حال الحملة لا تسمح بهذا الإجراء');
      await fn(c, rows[0]);
    });
    return this.detail(id);
  }

  submit(id: string, actor: AuthUser) {
    return this.transition(id, actor, ['DRAFT'], async (c) => {
      await c.query("update campaigns set status = 'PENDING_APPROVAL' where id = $1", [id]);
      await this.audit.append(c, { actorId: actor.id, action: 'campaign.submit', entity: 'campaign', entityId: id });
    });
  }

  /** الاعتماد يصدر الرموز: لكل استحقاق رمز رقمي للرسائل النصية، والرمز الموقَّع يُشتق عند الطلب. */
  async decide(id: string, approve: boolean, note: string | undefined, actor: AuthUser) {
    const result = await this.decideTx(id, approve, note, actor);
    // دعوة الاستلام تخرج بعد ثبوت الاعتماد، ومعها الرمز الرقمي لكل عائلة.
    if (approve) await this.notifications.system('CAMPAIGN_INVITE', `دعوة الاستلام: ${result.name}`, INVITE, { campaignId: id });
    return result;
  }

  private decideTx(id: string, approve: boolean, note: string | undefined, actor: AuthUser) {
    return this.transition(id, actor, ['PENDING_APPROVAL'], async (c, row) => {
      if (row.created_by === actor.id) throw new ForbiddenException('لا يعتمد الموظف حملة أنشأها بنفسه');
      if (!approve && !note) throw new BadRequestException('يلزم ذكر سبب الرفض');
      if (approve) {
        const ents = await c.query('select e.id, f.family_no from entitlements e join families f on f.id = e.family_id where e.campaign_id = $1', [id]);
        const codes = ents.rows.map(() => String(randomInt(0, 100_000_000)).padStart(8, '0'));
        await c.query(
          `update entitlements e set code_hash = x.hash, code_enc = x.enc
           from unnest($1::uuid[], $2::text[], $3::text[]) as x(id, hash, enc) where e.id = x.id`,
          [ents.rows.map((r) => r.id), ents.rows.map((r, i) => this.codeHash(id, r.family_no, codes[i])), codes.map((code) => this.crypto.encrypt(code))],
        );
      } else {
        await c.query("update entitlements set status = 'CANCELLED' where campaign_id = $1", [id]);
      }
      await c.query('update campaigns set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1', [id, approve ? 'ACTIVE' : 'REJECTED', actor.id, note ?? null]);
      await this.audit.append(c, { actorId: actor.id, action: approve ? 'campaign.approve' : 'campaign.reject', entity: 'campaign', entityId: id, payload: { note: note ?? null } });
    });
  }

  cancel(id: string, note: string, actor: AuthUser) {
    return this.transition(id, actor, ['DRAFT', 'PENDING_APPROVAL'], async (c) => {
      await c.query("update entitlements set status = 'CANCELLED' where campaign_id = $1", [id]);
      await c.query("update campaigns set status = 'CANCELLED', decision_note = $2 where id = $1", [id, note]);
      await this.audit.append(c, { actorId: actor.id, action: 'campaign.cancel', entity: 'campaign', entityId: id, payload: { note } });
    });
  }

  /** الإقفال: ما لم يُستلم يُلغى، فلا يُقبل رمزه بعد. */
  close(id: string, actor: AuthUser) {
    return this.transition(id, actor, ['ACTIVE'], async (c) => {
      const left = await c.query("update entitlements set status = 'CANCELLED' where campaign_id = $1 and status = 'PENDING'", [id]);
      await c.query("update campaigns set status = 'CLOSED', closed_by = $2, closed_at = now() where id = $1", [id, actor.id]);
      await this.audit.append(c, { actorId: actor.id, action: 'campaign.close', entity: 'campaign', entityId: id, payload: { undelivered: left.rowCount } });
    });
  }

  private codeHash(campaignId: string, familyNo: string, code: string) {
    return this.crypto.blindIndex(`CODE:${campaignId}:${familyNo}:${toAsciiDigits(code).replace(/\D/g, '')}`);
  }

  private tokenFor(r: any): string {
    const end = new Date(r.ends_on);
    end.setHours(23, 59, 59);
    return this.signer.issue({ e: r.id, c: r.campaign_id, p: r.point_id, f: r.family_no, q: r.quantity, x: Math.floor(end.getTime() / 1000) });
  }

  /** الرموز للطباعة أو الإرسال. الاطلاع عليها يُسجَّل، فمن ملكها ملك الاستلام. */
  async tokens(id: string, actor: AuthUser) {
    const { rows } = await this.db.query(`${ENT_SQL} where e.campaign_id = $1 and c.status = 'ACTIVE' and e.status = 'PENDING' order by e.serial`, [id]);
    if (!rows.length) throw new ConflictException('لا رموز: الحملة ليست جارية أو سُلِّم كل ما فيها');
    await this.db.tx((c) => this.audit.append(c, { actorId: actor.id, action: 'campaign.tokens_export', entity: 'campaign', entityId: id, payload: { count: rows.length } }));
    return rows.map((r) => ({
      entitlementId: r.id, serial: r.serial, familyNo: r.family_no, headName: r.head_name, point: r.assigned_point_name,
      quantity: r.quantity, unit: r.unit, token: this.tokenFor(r), code: this.crypto.decrypt(r.code_enc),
    }));
  }

  /** بيان الحملة لجهاز يعمل دون اتصال: استحقاقات نقطته وشبّاكه فقط. */
  async manifest(id: string, pointId: string, lane: number, lanes: number): Promise<Manifest & { campaignName: string; unit: string }> {
    if (!(lanes >= 1 && lanes <= 50 && lane >= 1 && lane <= lanes)) throw new BadRequestException('رقم الشبّاك غير صالح');
    const { rows } = await this.db.query(`${ENT_SQL} where e.campaign_id = $1 and e.point_id = $2 and c.status = 'ACTIVE' order by e.serial`, [id, pointId]);
    const camp = await this.db.query("select name, unit, ends_on from campaigns where id = $1 and status = 'ACTIVE'", [id]);
    if (!camp.rows[0]) throw new ConflictException('الحملة ليست جارية');
    const mine = rows.filter((_, i) => laneOf(i, lanes) === lane);
    const proxies = await this.db.query('select family_id, full_name from proxies where active and family_id = any($1)', [mine.map((r) => r.family_id)]);
    const end = new Date(camp.rows[0].ends_on);
    end.setHours(23, 59, 59);
    return {
      campaignId: id, campaignName: camp.rows[0].name, unit: camp.rows[0].unit, pointId, lane, lanes,
      publicKey: this.signer.publicKeyB64, endsAt: Math.floor(end.getTime() / 1000),
      entries: mine.map((r) => ({
        id: r.id, familyNo: r.family_no, headName: r.head_name, quantity: r.quantity, codeHash: r.code_hash, status: r.status,
        receivers: [{ kind: 'HEAD' as const, name: r.head_name }, ...proxies.rows.filter((p) => p.family_id === r.family_id).map((p) => ({ kind: 'PROXY' as const, name: p.full_name }))],
      })),
    };
  }

  // ---------- التسليم ----------

  private async incident(kind: IncidentKind, st: Station, row: { id?: string; campaign_id?: string } | null, details: Record<string, unknown> = {}) {
    // معرّف الحملة قد يكون ادّعاءً من رمز مزوَّر، فلا يُكتب إلا إن وُجدت حملة به.
    await this.db.query(
      `insert into delivery_incidents (kind, entitlement_id, campaign_id, point_id, device_id, reported_by, details)
       values ($1, $2, (select id from campaigns where id = $3), $4, $5, $6, $7)`,
      [kind, row?.id ?? null, row?.campaign_id ?? null, st.pointId, st.deviceId, st.actor.id, JSON.stringify(details)],
    );
  }

  /** رفضٌ يحمل بلاغه. البلاغ يُكتب بعد انتهاء المعاملة، فلا ينتظر قفلاً تمسكه هي. */
  private refuse(kind: IncidentKind, row: { id?: string; campaign_id?: string } | null = null, details: Record<string, unknown> = {}): never {
    throw new Refusal(kind, row ? { id: row.id, campaign_id: row.campaign_id } : null, details);
  }

  /** ينفّذ العمل؛ فإن رُفض سجّل البلاغ ثم أعاد الرفض بنصّه العربي. */
  private async guarded<T>(st: Station, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      await this.incident(err.kind, st, err.row, err.details);
      throw new ConflictException({ message: MESSAGES[err.kind], code: err.kind, details: err.details });
    }
  }

  /** يجد الاستحقاق من الرمز أو من رقم العائلة ورمزها الرقمي، ويتحقق أنه يُقبل الآن. كل رفض يُسجَّل. */
  private async locate(q: { query: (t: string, p?: any[]) => Promise<{ rows: any[] }> }, input: CheckInput['locate'], lock: boolean) {
    let row: any;
    // «no key update» يقفل السجل دون أن يحجب فحص المفاتيح الأجنبية عن غيره.
    const tail = lock ? ' for no key update of e' : '';
    if ('token' in input) {
      const payload = verifyToken(input.token, this.signer.publicKeyB64);
      // الرمز المزوَّر يُنسب إلى الحملة التي يدّعيها (إن وُجدت) ليراه مديرها في بلاغاتها.
      if (!payload) this.refuse('BAD_SIGNATURE', { campaign_id: claimedCampaign(input.token) });
      row = (await q.query(`${ENT_SQL} where e.id = $1${tail}`, [payload.e])).rows[0];
      if (!row || row.campaign_id !== payload.c) this.refuse('BAD_SIGNATURE', { campaign_id: payload.c });
    } else {
      row = (await q.query(`${ENT_SQL} where e.campaign_id = $1 and f.family_no = $2${tail}`, [input.campaignId, toAsciiDigits(input.familyNo).trim()])).rows[0];
      if (!row || !row.code_hash || row.code_hash !== this.codeHash(input.campaignId, row.family_no, input.code)) {
        this.refuse('BAD_CODE', row ?? { campaign_id: input.campaignId });
      }
    }
    if (row.status === 'DELIVERED') {
      this.refuse('ALREADY_DELIVERED', row, { familyNo: row.family_no, deliveredAt: row.delivered_at, point: row.delivered_point_name, receiverName: row.receiver_name, receiver: row.receiver });
    }
    if (row.campaign_status !== 'ACTIVE') this.refuse('NOT_ACTIVE', row);
    if (row.status === 'CANCELLED') this.refuse('CANCELLED', row);
    const end = new Date(row.ends_on);
    end.setHours(23, 59, 59);
    if (Date.now() > end.getTime()) this.refuse('EXPIRED', row);
    return row;
  }

  private async receivers(familyId: string, headName: string) {
    const { rows } = await this.db.query('select id, full_name, relation from proxies where family_id = $1 and active order by full_name', [familyId]);
    return [{ kind: 'HEAD' as const, name: headName }, ...rows.map((p) => ({ kind: 'PROXY' as const, proxyId: p.id as string, name: p.full_name as string, relation: p.relation as string | null }))];
  }

  /** يتحقق من الرمز ويعرض من يجوز له الاستلام، دون أن يغيّر شيئاً. */
  async check(input: CheckInput, actor: AuthUser) {
    const st = { actor, pointId: input.pointId, deviceId: input.deviceId };
    const row = await this.guarded(st, () => this.locate(this.db, input.locate, false));
    return {
      entitlementId: row.id, familyId: row.family_id, familyNo: row.family_no, headName: row.head_name, quantity: row.quantity, unit: row.unit,
      campaignId: row.campaign_id, campaignName: row.campaign_name, assignedPoint: row.assigned_point_name, atAssignedPoint: row.point_id === input.pointId,
      receivers: await this.receivers(row.family_id, row.head_name),
    };
  }

  /** التسليم والجهاز متصل: يُقبل الرمز في أي نقطة، ويُبطَل في الجميع لحظتها. */
  async redeem(input: RedeemInput, actor: AuthUser) {
    const st = { actor, pointId: input.pointId, deviceId: input.deviceId };
    const prior = await this.db.query('select id from entitlements where client_op_id = $1', [input.clientOpId]);
    if (prior.rows[0]) return this.delivered(prior.rows[0].id);

    const id = await this.guarded(st, () => this.db.tx(async (c) => {
      const row = await this.locate(c, input.locate, true);
      let receiverName: string = row.head_name;
      if (input.receiver.kind === 'PROXY') {
        const p = await c.query('select full_name from proxies where id = $1 and family_id = $2 and active', [input.receiver.proxyId, row.family_id]);
        if (!p.rows[0]) throw new ForbiddenException('ليس وكيلاً مسجَّلاً لهذه العائلة. لا يستلم إلا رب الأسرة أو وكيل مسجَّل.');
        receiverName = p.rows[0].full_name;
      }
      await c.query(
        `update entitlements set status = 'DELIVERED', delivered_at = now(), delivered_by = $2, delivered_point = $3, device_id = $4,
                mode = 'ONLINE', receiver = $5, receiver_name = $6, client_op_id = $7
         where id = $1 and status = 'PENDING'`,
        [row.id, actor.id, input.pointId, input.deviceId, input.receiver.kind, receiverName, input.clientOpId],
      );
      await this.audit.append(c, {
        actorId: actor.id, action: 'delivery.redeem', entity: 'entitlement', entityId: row.id,
        payload: { familyNo: row.family_no, campaignId: row.campaign_id, pointId: input.pointId, deviceId: input.deviceId, receiver: input.receiver.kind, receiverName, quantity: row.quantity },
      });
      return row.id as string;
    }));
    await this.confirm(id);
    return this.delivered(id);
  }

  /** رسالة التأكيد بعد التسليم: إن لم تكن العائلة هي المستلمة علمت في حينه. */
  private async confirm(entitlementId: string) {
    const r = (await this.db.query(`${ENT_SQL} where e.id = $1`, [entitlementId])).rows[0];
    if (!r || r.status !== 'DELIVERED') return;
    const when = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(r.delivered_at));
    const body = `السلام عليكم {الاسم}. استُلمت مستحقاتكم (${r.quantity} ${r.unit}) من نقطة ${r.delivered_point_name} في ${when}، واستلمها ${r.receiver === 'PROXY' ? 'وكيلكم' : 'رب الأسرة'} ${r.receiver_name}. إن لم تستلموها فراجعوا المركز فوراً. رقم العائلة: {رقم_العائلة}`;
    await this.notifications.system('DELIVERY_CONFIRMATION', 'تأكيد التسليم', body, {}, r.family_id);
  }

  private async delivered(id: string) {
    const r = (await this.db.query(`${ENT_SQL} where e.id = $1`, [id])).rows[0];
    return {
      entitlementId: r.id, familyId: r.family_id, familyNo: r.family_no, quantity: r.quantity, unit: r.unit, campaignName: r.campaign_name,
      receiver: r.receiver, receiverName: r.receiver_name, deliveredAt: r.delivered_at, point: r.delivered_point_name, mode: r.mode,
    };
  }

  /**
   * مزامنة ما سُلِّم دون اتصال. الواقع يُسجَّل كما وقع؛ وما خالف القاعدة يُرفع بلاغاً باسم الموظف والجهاز:
   * تسليم ثانٍ لاستحقاق سُلِّم، أو تسليم في غير النقطة المعيَّنة.
   */
  async sync(input: SyncInput, actor: AuthUser) {
    const st = { actor, pointId: input.pointId, deviceId: input.deviceId };
    const results: { clientOpId: string; result: 'APPLIED' | 'ALREADY_SYNCED' | 'CONFLICT' | 'UNKNOWN'; details?: unknown }[] = [];
    for (const item of input.items) {
      const result = await this.db.tx(async (c) => {
        const row = (await c.query(`${ENT_SQL} where e.id = $1 for no key update of e`, [item.entitlementId])).rows[0];
        if (!row) return { result: 'UNKNOWN' as const };
        if (row.status === 'DELIVERED') {
          if (row.client_op_id === item.clientOpId) return { result: 'ALREADY_SYNCED' as const };
          const details = {
            familyNo: row.family_no,
            first: { at: row.delivered_at, point: row.delivered_point_name, receiverName: row.receiver_name, mode: row.mode },
            second: { at: item.deliveredAt, receiverName: item.receiverName },
          };
          await c.query(
            'insert into delivery_incidents (kind, entitlement_id, campaign_id, point_id, device_id, reported_by, details) values ($1,$2,$3,$4,$5,$6,$7)',
            ['DOUBLE_DELIVERY', row.id, row.campaign_id, st.pointId, st.deviceId, actor.id, JSON.stringify(details)],
          );
          await this.audit.append(c, { actorId: actor.id, action: 'delivery.double', entity: 'entitlement', entityId: row.id, payload: details });
          return { result: 'CONFLICT' as const, details };
        }
        const at = new Date(Math.min(new Date(item.deliveredAt).getTime(), Date.now()));
        await c.query(
          `update entitlements set status = 'DELIVERED', delivered_at = $2, delivered_by = $3, delivered_point = $4, device_id = $5,
                  mode = 'OFFLINE', receiver = $6, receiver_name = $7, client_op_id = $8 where id = $1`,
          [row.id, at.toISOString(), actor.id, st.pointId, st.deviceId, item.receiver, item.receiverName, item.clientOpId],
        );
        if (row.point_id !== st.pointId) {
          await c.query(
            'insert into delivery_incidents (kind, entitlement_id, campaign_id, point_id, device_id, reported_by, details) values ($1,$2,$3,$4,$5,$6,$7)',
            ['WRONG_POINT_OFFLINE', row.id, row.campaign_id, st.pointId, st.deviceId, actor.id, JSON.stringify({ familyNo: row.family_no, assignedPoint: row.assigned_point_name })],
          );
        }
        await this.audit.append(c, {
          actorId: actor.id, action: 'delivery.sync', entity: 'entitlement', entityId: row.id,
          payload: { familyNo: row.family_no, campaignId: row.campaign_id, pointId: st.pointId, deviceId: st.deviceId, receiver: item.receiver, receiverName: item.receiverName, deliveredAt: at.toISOString() },
        });
        return { result: 'APPLIED' as const };
      });
      if (result.result === 'APPLIED') await this.confirm(item.entitlementId);
      results.push({ clientOpId: item.clientOpId, ...result });
    }
    return { applied: results.filter((r) => r.result === 'APPLIED').length, conflicts: results.filter((r) => r.result === 'CONFLICT').length, results };
  }

  /** صورة التسليم: تُرفق بملف العائلة وتُربط بالاستحقاق. */
  async proof(entitlementId: string, file: { buffer: Buffer; originalname: string } | undefined, actor: AuthUser) {
    const { rows } = await this.db.query("select family_id from entitlements where id = $1 and status = 'DELIVERED'", [entitlementId]);
    if (!rows[0]) throw new NotFoundException('لا تسليم بهذا المعرّف');
    const a = await this.attachments.upload(rows[0].family_id, file, 'DELIVERY_PROOF', undefined, actor);
    await this.db.query('update entitlements set proof_attachment = $2 where id = $1', [entitlementId, a.id]);
    return { attachmentId: a.id };
  }

  async familyDeliveries(familyId: string) {
    const { rows } = await this.db.query(
      `${ENT_SQL} where e.family_id = $1 and (e.status = 'DELIVERED' or (e.status = 'PENDING' and c.status = 'ACTIVE')) order by e.delivered_at desc nulls first`,
      [familyId],
    );
    return rows.map((r) => ({
      entitlementId: r.id, campaignId: r.campaign_id, campaignName: r.campaign_name, quantity: r.quantity, unit: r.unit, status: r.status,
      deliveredAt: r.delivered_at, point: r.delivered_point_name ?? r.assigned_point_name, receiver: r.receiver, receiverName: r.receiver_name,
      proofAttachmentId: r.proof_attachment,
    }));
  }
}
