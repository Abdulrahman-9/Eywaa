import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '../db/db.module';

const CLASS_AR: Record<string, string> = { A: 'أ', B: 'ب', C: 'ج', D: 'د' };
const STATUS_AR: Record<string, string> = { APPROVED: 'معتمد', PENDING_APPROVAL: 'بانتظار الاعتماد', PENDING_DEDUPE_REVIEW: 'شبهة تكرار', REJECTED: 'مرفوض' };
const TAG_AR: Record<string, string> = { ORPHANS: 'أيتام', WIDOW: 'أرامل', DISABLED: 'معاقون', SICK: 'مرضى', DIVORCED: 'مطلقات', NEEDY: 'متعففون', UNMARRIED: 'عوانس' };

/** CSV يفتحه Excel بالعربية: علامة BOM في أوله، وكل خانة بين علامتَي تنصيص. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v);
    // ما يبدأ بعلامة صيغة يُسبَق بفاصلة عليا، لئلا ينفّذه برنامج الجداول صيغةً.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

@Injectable()
export class ReportsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** العوائل التي وصلها عطاء في كل شهر، لآخر اثني عشر شهراً. */
  async monthly() {
    const { rows } = await this.db.query(
      `select to_char(m, 'YYYY-MM') as month, count(distinct e.family_id)::int as families, count(e.id)::int as deliveries
       from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m
         left join entitlements e on e.status = 'DELIVERED' and date_trunc('month', e.delivered_at) = m
       group by m order by m`,
    );
    return rows;
  }

  async familiesCsv(filter: { class?: string; status?: string }) {
    const { rows } = await this.db.query(
      `select f.family_no, h.full_name, f.status, sc.class, sc.points, f.tags::text[] as tags, f.mahalla, f.phone1, f.housing,
              (select count(*) from persons p where p.family_id = f.id and p.status = 'ACTIVE')::int as members,
              coalesce((select sum(amount_iqd) from income_sources i where i.family_id = f.id), 0)::int as income
       from families f left join persons h on h.family_id = f.id and h.relation = 'HEAD' left join family_scores sc on sc.family_id = f.id
       where ($1::text is null or sc.class = $1) and ($2::family_status is null or f.status = $2)
       order by f.family_no`,
      [filter.class ?? null, filter.status ?? null],
    );
    return toCsv(
      ['رقم العائلة', 'رب الأسرة', 'الحال', 'الفئة', 'النقاط', 'الأفراد', 'الدخل الشهري', 'الفئات', 'المحلة', 'الهاتف'],
      rows.map((r) => [r.family_no, r.full_name, STATUS_AR[r.status], r.class ? CLASS_AR[r.class] : '', r.points, r.members, r.income, r.tags.map((t: string) => TAG_AR[t]).join('، '), r.mahalla, r.phone1]),
    );
  }

  /** كشف التسليم لحملة: كل عائلة وحالها ومن استلم ومتى. */
  async campaignCsv(campaignId: string) {
    const camp = (await this.db.query('select name, unit from campaigns where id = $1', [campaignId])).rows[0];
    if (!camp) throw new NotFoundException('الحملة غير موجودة');
    const { rows } = await this.db.query(
      `select e.serial, f.family_no, h.full_name, ap.name as point, e.quantity, e.status, e.delivered_at, dp.name as delivered_point,
              e.receiver, e.receiver_name, e.mode, u.username, e.proof_attachment is not null as proof
       from entitlements e join families f on f.id = e.family_id left join persons h on h.family_id = f.id and h.relation = 'HEAD'
         join distribution_points ap on ap.id = e.point_id left join distribution_points dp on dp.id = e.delivered_point left join users u on u.id = e.delivered_by
       where e.campaign_id = $1 order by e.serial`,
      [campaignId],
    );
    const when = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { dateStyle: 'short', timeStyle: 'short' });
    return {
      name: camp.name as string,
      csv: toCsv(
        ['التسلسل', 'رقم العائلة', 'رب الأسرة', 'النقطة المعيَّنة', `المقدار (${camp.unit})`, 'الحال', 'وقت التسليم', 'نقطة التسليم', 'المستلم', 'اسم المستلم', 'الطريقة', 'الموظف', 'صورة'],
        rows.map((r) => [
          r.serial, r.family_no, r.full_name, r.point, r.quantity, { PENDING: 'لم يستلم', DELIVERED: 'استلم', CANCELLED: 'ملغى' }[r.status as string],
          r.delivered_at ? when.format(new Date(r.delivered_at)) : '', r.delivered_point, r.receiver === 'PROXY' ? 'وكيل' : r.receiver === 'HEAD' ? 'رب الأسرة' : '',
          r.receiver_name, r.mode === 'OFFLINE' ? 'دون اتصال' : r.mode === 'ONLINE' ? 'متصل' : '', r.username, r.proof ? 'نعم' : '',
        ]),
      ),
    };
  }

  /**
   * ملفات تقادم تقييمها: معتمدة ولم تُمسّ بياناتها (اعتماد أو تعديل معتمَد) منذ مدة.
   * إعادة التقييم عند الطلب، فهذا التقرير يُنبّه ولا يُلزم.
   */
  async stale(months: number) {
    const { rows } = await this.db.query(
      `select f.id, f.family_no, h.full_name, sc.class,
              greatest(f.decided_at, (select max(r.decided_at) from change_requests r where r.family_id = f.id and r.status = 'APPROVED')) as last_touch
       from families f left join persons h on h.family_id = f.id and h.relation = 'HEAD' left join family_scores sc on sc.family_id = f.id
       where f.status = 'APPROVED'
         and greatest(f.decided_at, (select max(r.decided_at) from change_requests r where r.family_id = f.id and r.status = 'APPROVED')) < now() - make_interval(months => $1)
       order by last_touch limit 500`,
      [months],
    );
    return rows.map((r) => ({ familyId: r.id, familyNo: r.family_no, headName: r.full_name, class: r.class, lastTouch: r.last_touch }));
  }

  /** عمليات كل موظف في مدة، من سجل التدقيق. */
  async staff(from: string, to: string) {
    const { rows } = await this.db.query(
      `select u.username, u.full_name, a.action, count(*)::int as n
       from audit_log a join users u on u.id = a.actor_id
       where a.at >= $1::date and a.at < $2::date + 1 and a.action <> 'auth.login'
       group by u.username, u.full_name, a.action order by u.username, n desc`,
      [from, to],
    );
    const by = new Map<string, { username: string; fullName: string; total: number; actions: Record<string, number> }>();
    for (const r of rows) {
      const e = by.get(r.username) ?? { username: r.username as string, fullName: r.full_name as string, total: 0, actions: {} as Record<string, number> };
      e.total += r.n;
      e.actions[r.action] = r.n;
      by.set(r.username, e);
    }
    return [...by.values()].sort((a, b) => b.total - a.total);
  }
}
