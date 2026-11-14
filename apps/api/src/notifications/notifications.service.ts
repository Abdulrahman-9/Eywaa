import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { FieldCrypto } from '../common/crypto';
import { Db } from '../db/db.module';
import { SendResult, chainFor, Channel, Channels, render, unknownVariables } from './channels';

export const audienceSchema = z.object({
  campaignId: z.string().uuid().optional(),
  /** في حملة: من لم يستلم بعد فقط. */
  pendingOnly: z.boolean().optional(),
  pointId: z.string().uuid().optional(),
  classes: z.array(z.enum(['A', 'B', 'C', 'D'])).min(1).optional(),
  tagsAny: z.array(z.string()).min(1).optional(),
  mahalla: z.string().trim().min(1).optional(),
  /** تنبيه فردي: عائلة بعينها. */
  familyId: z.string().uuid().optional(),
}).strict();
export type Audience = z.infer<typeof audienceSchema>;

export const composeSchema = z.object({
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(5).max(1000),
  audience: audienceSchema,
});
export type ComposeInput = z.infer<typeof composeSchema>;

interface Recipient {
  familyId: string; familyNo: string; headName: string; phone: string | null; hasWhatsapp: boolean; prefersVoice: boolean;
  point?: string; endsOn?: string; quantity?: number; unit?: string; codeEnc?: string;
}

/** مهلة إعادة المحاولة بعد العطل العابر، بالدقائق: دقيقة، ثم خمس، ثم ثلاثون. بعدها تُعدّ الرسالة مخفقة. */
const RETRY_AFTER_MIN = [1, 5, 30];
const dateAr = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(Channels) private readonly channels: Channels,
  ) {}

  /** العوائل المعتمدة التي يطابقها الاختيار، ومعها ما يلزم لملء المتغيرات. */
  private async recipients(a: Audience, onlyFamily?: string): Promise<Recipient[]> {
    if ((a.pendingOnly || a.pointId) && !a.campaignId) throw new BadRequestException('حال الاستلام والنقطة لا يُختاران إلا مع حملة');
    const { rows } = await this.db.query(
      `select f.id, f.family_no, f.phone1, f.has_whatsapp, f.prefers_voice, h.full_name as head_name,
              dp.name as point, c.ends_on, c.unit, e.quantity, e.code_enc
       from families f
         left join persons h on h.family_id = f.id and h.relation = 'HEAD'
         left join family_scores sc on sc.family_id = f.id
         left join entitlements e on e.family_id = f.id and e.campaign_id = $1
         left join campaigns c on c.id = e.campaign_id
         left join distribution_points dp on dp.id = e.point_id
       where f.status = 'APPROVED'
         and ($1::uuid is null or e.id is not null)
         and (not $2::boolean or e.status = 'PENDING')
         and ($3::uuid is null or e.point_id = $3)
         and ($4::text[] is null or sc.class = any($4))
         and ($5::text[] is null or f.tags::text[] && $5)
         and ($6::text is null or f.mahalla = $6)
         and ($7::uuid is null or f.id = $7)
       order by f.family_no`,
      [a.campaignId ?? null, !!a.pendingOnly, a.pointId ?? null, a.classes ?? null, a.tagsAny ?? null, a.mahalla ?? null, onlyFamily ?? a.familyId ?? null],
    );
    return rows.map((r) => ({
      familyId: r.id, familyNo: r.family_no, headName: r.head_name, phone: r.phone1, hasWhatsapp: r.has_whatsapp, prefersVoice: r.prefers_voice,
      point: r.point ?? undefined, endsOn: r.ends_on ?? undefined, quantity: r.quantity ?? undefined, unit: r.unit ?? undefined, codeEnc: r.code_enc ?? undefined,
    }));
  }

  private textFor(body: string, r: Recipient): string {
    return render(body, {
      'الاسم': r.headName, 'رقم_العائلة': r.familyNo, 'النقطة': r.point,
      'آخر_موعد': r.endsOn ? dateAr.format(new Date(r.endsOn)) : undefined,
      'المقدار': r.quantity !== undefined ? `${r.quantity} ${r.unit ?? ''}`.trim() : undefined,
      'الرمز_الرقمي': r.codeEnc ? this.crypto.decrypt(r.codeEnc) : undefined,
    });
  }

  private validateBody(body: string, a: Audience) {
    const unknown = unknownVariables(body);
    if (unknown.length) throw new BadRequestException(`في النص متغيرات لا يعرفها النظام: ${unknown.map((u) => `{${u}}`).join('، ')}`);
    if (!a.campaignId && /\{(النقطة|آخر_موعد|المقدار|الرمز_الرقمي)\}/.test(body)) {
      throw new BadRequestException('النقطة والموعد والمقدار والرمز الرقمي لا تُستعمل إلا في رسالة موجَّهة إلى حملة');
    }
  }

  async preview(input: ComposeInput) {
    this.validateBody(input.body, input.audience);
    const list = await this.recipients(input.audience);
    const threshold = (await this.db.query("select value from settings where key = 'bulk_message_approval_threshold'")).rows[0].value as number;
    const byChannel: Record<string, number> = { WHATSAPP: 0, SMS: 0, VOICE: 0, NO_PHONE: 0 };
    for (const r of list) byChannel[r.phone ? chainFor(r)[0] : 'NO_PHONE']++;
    return {
      recipients: list.length, byChannel, needsApproval: list.length > threshold, threshold,
      sample: list[0] ? this.textFor(input.body, list[0]) : null,
      // الرسالة النصية الواحدة بالعربية 70 حرفاً، وما زاد يُقسَّم على رسائل من 67.
      smsParts: list[0] ? (this.textFor(input.body, list[0]).length <= 70 ? 1 : Math.ceil(this.textFor(input.body, list[0]).length / 67)) : 0,
      driver: { name: this.channels.current.name, live: this.channels.current.live },
    };
  }

  /**
   * يكتب رسالة لكل عائلة في الطابور. الكتابة دفعة واحدة، والإرسال بعدها:
   * مع المحاكاة يُرسل في الحال، ومع مزوّد حقيقي يرسله العامل بسرعة محدودة (انظر processQueue).
   */
  private async deliver(notificationId: string, body: string, list: Recipient[]) {
    const rows = list.map((r) => ({ familyId: r.familyId, phone: r.phone ?? null, text: this.textFor(body, r), chain: r.phone ? chainFor(r) : [] }));
    for (let i = 0; i < rows.length; i += 1000) {
      const part = rows.slice(i, i + 1000);
      await this.db.query(
        `insert into messages (notification_id, family_id, phone, text, status, chain, next_attempt_at)
         select $1, f, p, t, (case when p is null then 'NO_PHONE' else 'QUEUED' end)::message_status, c::message_channel[], case when p is null then null else now() end
         from unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) as x(f, p, t, c)`,
        [notificationId, part.map((r) => r.familyId), part.map((r) => r.phone), part.map((r) => r.text), part.map((r) => `{${r.chain.join(',')}}`)],
      );
    }
    if (!this.channels.current.live) while ((await this.processQueue(500, notificationId)) > 0);
  }

  /**
   * يأخذ من الطابور حتى limit رسالة حان وقتها ويرسلها. يعيد عدد ما أخذ.
   * الأخذ «إعارة» عشر دقائق: إن مات الخادم والرسالة بيده عادت إلى الطابور بعدها.
   * فالضمان «مرة على الأقل»: إن قبلها المزوّد ومات الخادم قبل أن يسجّل، أُرسلت ثانية.
   */
  async processQueue(limit: number, notificationId?: string): Promise<number> {
    const driver = this.channels.current;
    const { rows } = await this.db.query(
      `update messages m set attempts = attempts + 1, next_attempt_at = now() + interval '10 minutes'
       where m.id in (select id from messages where status = 'QUEUED' and next_attempt_at <= now() and ($2::uuid is null or notification_id = $2)
                      order by next_attempt_at limit $1 for update skip locked)
       returning m.id, m.phone, m.text, m.chain::text[] as chain, m.attempts`,
      [limit, notificationId ?? null],
    );
    for (const m of rows) {
      const tried: Channel[] = [];
      let sent: { channel: Channel; ref?: string } | null = null;
      let error: string | undefined;
      let transient = false;
      // بترتيب القنوات: إن أخفقت قناة جُرِّبت التي بعدها.
      for (const channel of m.chain as Channel[]) {
        tried.push(channel);
        const res: SendResult = await driver.send(channel, m.phone, m.text).catch((e: Error) => ({ ok: false, error: e.message, retry: true }));
        if (res.ok) { sent = { channel, ref: res.providerRef }; break; }
        error = res.error ?? 'أخفق الإرسال';
        transient ||= !!res.retry;
      }
      if (sent) {
        await this.db.query("update messages set status = 'SENT', channel = $2, tried = $3, provider_ref = $4, error = null, next_attempt_at = null, sent_at = now() where id = $1", [m.id, sent.channel, tried, sent.ref ?? null]);
      } else if (transient && m.attempts < RETRY_AFTER_MIN.length + 1) {
        // عطل عابر: تعود إلى الطابور بعد مهلة تطول مع كل محاولة.
        await this.db.query("update messages set tried = $2, error = $3, next_attempt_at = now() + make_interval(mins => $4) where id = $1", [m.id, tried, error, RETRY_AFTER_MIN[m.attempts - 1]]);
      } else {
        await this.db.query("update messages set status = 'FAILED', channel = $2, tried = $3, error = $4, next_attempt_at = null where id = $1", [m.id, tried[tried.length - 1] ?? null, tried, error ?? 'لا قناة لهذه العائلة']);
      }
    }
    return rows.length;
  }

  /** إشعار المزوّد بأن الرسالة بلغت الهاتف أو قُرئت أو أخفقت بعد قبولها. */
  async providerStatus(providerRef: string, status: 'DELIVERED' | 'READ' | 'FAILED', error?: string): Promise<boolean> {
    // الحال لا ترجع إلى الوراء: المقروءة لا تصير «بلغت»، والتي بلغت لا تصير مخفقة.
    const from = status === 'READ' ? ['SENT', 'DELIVERED'] : ['SENT'];
    const { rowCount } = await this.db.query(
      'update messages set status = $2, error = $3 where provider_ref = $1 and status::text = any($4)', [providerRef, status, status === 'FAILED' ? (error ?? 'أخفق عند المزوّد') : null, from]);
    return !!rowCount;
  }

  async compose(input: ComposeInput, actor: AuthUser) {
    const p = await this.preview(input);
    if (!p.recipients) throw new ConflictException('لا عائلة تطابق هذا الاختيار');
    const list = await this.recipients(input.audience);
    const id = await this.db.tx(async (c) => {
      const { rows } = await c.query(
        'insert into notifications (title, body, audience, campaign_id, status, recipients, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [input.title, input.body, JSON.stringify(input.audience), input.audience.campaignId ?? null, p.needsApproval ? 'PENDING_APPROVAL' : 'SENT', list.length, actor.id],
      );
      await this.audit.append(c, { actorId: actor.id, action: 'notification.compose', entity: 'notification', entityId: rows[0].id, payload: { title: input.title, recipients: list.length, needsApproval: p.needsApproval } });
      return rows[0].id as string;
    });
    if (!p.needsApproval) await this.deliver(id, input.body, list);
    return this.detail(id);
  }

  async decide(id: string, approve: boolean, note: string | undefined, actor: AuthUser) {
    const n = await this.db.tx(async (c) => {
      const { rows } = await c.query('select * from notifications where id = $1 for update', [id]);
      if (!rows[0]) throw new NotFoundException('الإرسال غير موجود');
      if (rows[0].status !== 'PENDING_APPROVAL') throw new ConflictException('فُصل في هذا الإرسال من قبل');
      if (rows[0].created_by === actor.id) throw new ForbiddenException('لا يعتمد الموظف إرسالاً أنشأه بنفسه');
      if (!approve && !note) throw new BadRequestException('يلزم ذكر سبب الرفض');
      await c.query('update notifications set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1', [id, approve ? 'SENT' : 'REJECTED', actor.id, note ?? null]);
      await this.audit.append(c, { actorId: actor.id, action: approve ? 'notification.approve' : 'notification.reject', entity: 'notification', entityId: id, payload: { note: note ?? null } });
      return rows[0];
    });
    // المخاطَبون يُحسبون عند الاعتماد لا عند الإنشاء: من استلم بينهما لا يُذكَّر.
    if (approve) await this.deliver(id, n.body, await this.recipients(n.audience));
    return this.detail(id);
  }

  /** رسائل يصدرها النظام من نفسه (دعوة الاستلام، تأكيد التسليم). لا تحتاج اعتماداً: يغطيها اعتماد الحملة. */
  async system(kind: 'CAMPAIGN_INVITE' | 'DELIVERY_CONFIRMATION', title: string, body: string, audience: Audience, onlyFamily?: string) {
    const list = await this.recipients(audience, onlyFamily);
    if (!list.length) return null;
    const { rows } = await this.db.query(
      "insert into notifications (kind, title, body, audience, campaign_id, status, recipients) values ($1,$2,$3,$4,$5,'SENT',$6) returning id",
      [kind, title, body, JSON.stringify(audience), audience.campaignId ?? null, list.length],
    );
    await this.deliver(rows[0].id, body, list);
    return rows[0].id as string;
  }

  async list() {
    const { rows } = await this.db.query(
      `select n.id, n.kind, n.title, n.status, n.recipients, n.created_at, u.username as created_by,
              count(m.id) filter (where m.status in ('SENT', 'DELIVERED', 'READ'))::int as sent,
              count(m.id) filter (where m.status = 'FAILED')::int as failed,
              count(m.id) filter (where m.status = 'QUEUED')::int as queued,
              count(m.id) filter (where m.status = 'NO_PHONE')::int as no_phone
       from notifications n left join users u on u.id = n.created_by left join messages m on m.notification_id = n.id
       where n.kind <> 'DELIVERY_CONFIRMATION'
       group by n.id, u.username order by n.created_at desc limit 100`,
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, recipients: r.recipients, createdAt: r.created_at, createdBy: r.created_by, sent: r.sent, failed: r.failed, queued: r.queued, noPhone: r.no_phone }));
  }

  async detail(id: string) {
    const { rows } = await this.db.query(
      `select n.*, cu.username as created_by_username, du.username as decided_by_username
       from notifications n left join users cu on cu.id = n.created_by left join users du on du.id = n.decided_by where n.id = $1`,
      [id],
    );
    const n = rows[0];
    if (!n) throw new NotFoundException('الإرسال غير موجود');
    const stats = await this.db.query('select status, channel, count(*)::int as n from messages where notification_id = $1 group by status, channel', [id]);
    const problems = await this.db.query(
      `select m.status, m.error, m.tried::text[] as tried, f.id as family_id, f.family_no, h.full_name as head_name
       from messages m join families f on f.id = m.family_id left join persons h on h.family_id = f.id and h.relation = 'HEAD'
       where m.notification_id = $1 and m.status in ('FAILED', 'NO_PHONE') order by f.family_no limit 200`,
      [id],
    );
    const byStatus: Record<string, number> = {};
    const byChannel: Record<string, number> = {};
    for (const s of stats.rows) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + s.n;
      if (s.channel && s.status !== 'FAILED') byChannel[s.channel] = (byChannel[s.channel] ?? 0) + s.n;
    }
    return {
      id: n.id, kind: n.kind, title: n.title, body: n.body, status: n.status, recipients: n.recipients, audience: n.audience,
      createdBy: n.created_by_username, createdAt: n.created_at, decidedBy: n.decided_by_username, decisionNote: n.decision_note,
      byStatus, byChannel,
      problems: problems.rows.map((p) => ({ familyId: p.family_id, familyNo: p.family_no, headName: p.head_name, status: p.status, error: p.error, tried: p.tried })),
    };
  }

  async forFamily(familyId: string) {
    const { rows } = await this.db.query(
      `select m.id, m.channel, m.status, m.text, m.sent_at, n.title, n.kind from messages m join notifications n on n.id = m.notification_id
       where m.family_id = $1 order by m.sent_at desc limit 50`,
      [familyId],
    );
    return rows.map((r) => ({ id: r.id, channel: r.channel, status: r.status, text: r.text, sentAt: r.sent_at, title: r.title, kind: r.kind }));
  }

  driver() {
    return { name: this.channels.current.name, live: this.channels.current.live };
  }
}
