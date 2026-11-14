import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { FieldCrypto } from '../common/crypto';
import { Db } from '../db/db.module';
import { chainFor, Channel, Channels, render, unknownVariables } from './channels';

export const audienceSchema = z.object({
  campaignId: z.string().uuid().optional(),
  /** في حملة: من لم يستلم بعد فقط. */
  pendingOnly: z.boolean().optional(),
  pointId: z.string().uuid().optional(),
  classes: z.array(z.enum(['A', 'B', 'C', 'D'])).min(1).optional(),
  tagsAny: z.array(z.string()).min(1).optional(),
  mahalla: z.string().trim().min(1).optional(),
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
      [a.campaignId ?? null, !!a.pendingOnly, a.pointId ?? null, a.classes ?? null, a.tagsAny ?? null, a.mahalla ?? null, onlyFamily ?? null],
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

  /** يرسل إلى كل عائلة بترتيب قنواتها: إن أخفقت قناة جُرِّبت التي بعدها. */
  private async deliver(notificationId: string, body: string, list: Recipient[]) {
    const driver = this.channels.current;
    for (const r of list) {
      const text = this.textFor(body, r);
      if (!r.phone) {
        await this.db.query("insert into messages (notification_id, family_id, text, status) values ($1,$2,$3,'NO_PHONE')", [notificationId, r.familyId, text]);
        continue;
      }
      const tried: Channel[] = [];
      let sent: { channel: Channel; ref?: string } | null = null;
      let error: string | undefined;
      for (const channel of chainFor(r)) {
        tried.push(channel);
        const res = await driver.send(channel, r.phone, text).catch((e: Error) => ({ ok: false, error: e.message, providerRef: undefined }));
        if (res.ok) { sent = { channel, ref: res.providerRef }; break; }
        error = res.error ?? 'أخفق الإرسال';
      }
      await this.db.query(
        'insert into messages (notification_id, family_id, phone, channel, text, status, tried, error, provider_ref) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [notificationId, r.familyId, r.phone, sent?.channel ?? tried[tried.length - 1], text, sent ? 'SENT' : 'FAILED', tried, sent ? null : error, sent?.ref ?? null],
      );
    }
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
              count(m.id) filter (where m.status = 'NO_PHONE')::int as no_phone
       from notifications n left join users u on u.id = n.created_by left join messages m on m.notification_id = n.id
       where n.kind <> 'DELIVERY_CONFIRMATION'
       group by n.id, u.username order by n.created_at desc limit 100`,
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, recipients: r.recipients, createdAt: r.created_at, createdBy: r.created_by, sent: r.sent, failed: r.failed, noPhone: r.no_phone }));
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
