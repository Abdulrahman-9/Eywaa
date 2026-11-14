import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '../db/db.module';

/** حدود الإنذار. ثابتة الآن؛ تُنقل إلى الإعدادات إن احتاج المركز ضبطها. */
export const ALERT_LIMITS = {
  /** الرمز المستعمل يُعرض هذا العدد من المرات فأكثر. */
  repeatedToken: 3,
  /** رموز خاطئة أو مزوَّرة من جهاز واحد، بهذا العدد، في هذه الدقائق. */
  badBurst: 5,
  badBurstMinutes: 10,
  /** نسبة الاستلام بالوكالة عند موظف، بعد هذا العدد من التسليمات، وضعف معدّل الحملة. */
  proxyShare: 0.5,
  proxyMinDeliveries: 10,
  /** التسليم بين هاتين الساعتين (بتوقيت بغداد) خارج الدوام. */
  nightFrom: 22,
  nightTo: 5,
};
const TZ = 'Asia/Baghdad';

export interface CampaignAlert { kind: string; severity: 'HIGH' | 'MEDIUM'; title: string; detail: string; at: string | null; familyNo?: string; who?: string }

/** متابعة الحملة يوماً بيوم، وإنذارات ما يشبه الاحتيال. تقرأ ولا تغيّر. */
@Injectable()
export class MonitorService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async daily(campaignId: string) {
    const camp = (await this.db.query('select unit from campaigns where id = $1', [campaignId])).rows[0];
    if (!camp) throw new NotFoundException('الحملة غير موجودة');
    const total = (await this.db.query('select count(*)::int as n from entitlements where campaign_id = $1', [campaignId])).rows[0].n;
    const d = await this.db.query(
      `select to_char(e.delivered_at at time zone '${TZ}', 'YYYY-MM-DD') as day, coalesce(dp.name, 'حوالة أو محفظة') as point,
              count(*)::int as n, sum(e.quantity)::int as q, count(*) filter (where e.receiver = 'PROXY')::int as proxy, count(*) filter (where e.mode = 'OFFLINE')::int as offline
       from entitlements e left join distribution_points dp on dp.id = e.delivered_point
       where e.campaign_id = $1 and e.status = 'DELIVERED' group by 1, 2 order by 1, 2`, [campaignId]);
    const i = await this.db.query(
      `select to_char(at at time zone '${TZ}', 'YYYY-MM-DD') as day, count(*)::int as n from delivery_incidents where campaign_id = $1 group by 1`, [campaignId]);
    const incidents = new Map(i.rows.map((r) => [r.day, r.n]));
    type Day = { day: string; delivered: number; quantity: number; byProxy: number; offline: number; incidents: number; points: { point: string; delivered: number; quantity: number }[] };
    const days = new Map<string, Day>();
    const blank = (day: string): Day => ({ day, delivered: 0, quantity: 0, byProxy: 0, offline: 0, incidents: incidents.get(day) ?? 0, points: [] });
    for (const r of d.rows) {
      const x = days.get(r.day) ?? blank(r.day);
      x.delivered += r.n; x.quantity += r.q; x.byProxy += r.proxy; x.offline += r.offline;
      x.points.push({ point: r.point, delivered: r.n, quantity: r.q });
      days.set(r.day, x);
    }
    // يوم فيه بلاغات ولا تسليم فيه يظهر أيضاً: هو أولى الأيام بالنظر.
    for (const day of incidents.keys()) if (!days.has(day)) days.set(day, blank(day));
    let cumulative = 0;
    const rows = [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((x) => {
      cumulative += x.delivered;
      return { ...x, cumulative, percent: total ? Math.round((cumulative / total) * 100) : 0 };
    });
    return { unit: camp.unit as string, families: total as number, delivered: cumulative, remaining: total - cumulative, days: rows };
  }

  async alerts(campaignId: string): Promise<CampaignAlert[]> {
    const L = ALERT_LIMITS;
    const out: CampaignAlert[] = [];
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

    const double = await this.db.query(
      `select i.at, i.details, u.username, f.family_no from delivery_incidents i join users u on u.id = i.reported_by
         left join entitlements e on e.id = i.entitlement_id left join families f on f.id = e.family_id
       where i.campaign_id = $1 and i.kind = 'DOUBLE_DELIVERY' order by i.at desc`, [campaignId]);
    for (const r of double.rows) {
      out.push({ kind: 'DOUBLE_DELIVERY', severity: 'HIGH', title: 'استحقاق سُلِّم مرتين', at: iso(r.at), familyNo: r.family_no, who: r.username,
        detail: `سلّمه ${r.username} من جهاز منقطع بعد أن استُلم${r.details?.first?.point ? ` في ${r.details.first.point}` : ''}${r.details?.first?.receiverName ? ` بيد ${r.details.first.receiverName}` : ''}. تُسأل العائلة: من استلم؟` });
    }

    const repeated = await this.db.query(
      `select f.family_no, count(*)::int as n, max(i.at) as at, string_agg(distinct u.username, '، ') as who, count(distinct i.point_id)::int as points
       from delivery_incidents i join users u on u.id = i.reported_by join entitlements e on e.id = i.entitlement_id join families f on f.id = e.family_id
       where i.campaign_id = $1 and i.kind = 'ALREADY_DELIVERED' group by f.family_no having count(*) >= $2 order by n desc`, [campaignId, L.repeatedToken]);
    for (const r of repeated.rows) {
      out.push({ kind: 'REPEATED_TOKEN', severity: r.n >= L.repeatedToken * 2 ? 'HIGH' : 'MEDIUM', title: `رمز مستعمل عُرض ${r.n} مرات`, at: iso(r.at), familyNo: r.family_no, who: r.who,
        detail: `رمز العائلة ${r.family_no} عُرض بعد استلامه ${r.n} مرات${r.points > 1 ? ` في ${r.points} نقاط` : ''}، أمام: ${r.who}. قد يكون الرمز منسوخاً أو متداولاً.` });
    }

    const multi = await this.db.query(
      `select f.family_no, array_agg(distinct dp.name) as points, max(x.at) as at from (
         select entitlement_id, point_id, at from delivery_incidents where campaign_id = $1 and entitlement_id is not null and point_id is not null
         union all select id, delivered_point, delivered_at from entitlements where campaign_id = $1 and delivered_point is not null
       ) x join distribution_points dp on dp.id = x.point_id join entitlements e on e.id = x.entitlement_id join families f on f.id = e.family_id
       group by f.family_no having count(distinct x.point_id) >= 2`, [campaignId]);
    for (const r of multi.rows) {
      out.push({ kind: 'MULTI_POINT', severity: 'MEDIUM', title: 'رمز عُرض في أكثر من نقطة', at: iso(r.at), familyNo: r.family_no,
        detail: `رمز العائلة ${r.family_no} عُرض في: ${r.points.join('، ')}.` });
    }

    const burst = await this.db.query(
      `select device_id, max(n)::int as n, max(at) as at, string_agg(distinct username, '، ') as who from (
         select i.device_id, i.at, u.username,
                count(*) over (partition by i.device_id order by i.at range between make_interval(mins => $3) preceding and current row) as n
         from delivery_incidents i join users u on u.id = i.reported_by
         where i.campaign_id = $1 and i.kind in ('BAD_SIGNATURE', 'BAD_CODE') and i.device_id is not null
       ) w group by device_id having max(n) >= $2`, [campaignId, L.badBurst, L.badBurstMinutes]);
    for (const r of burst.rows) {
      out.push({ kind: 'BAD_BURST', severity: 'HIGH', title: `${r.n} رموز خاطئة في ${L.badBurstMinutes} دقائق من جهاز واحد`, at: iso(r.at), who: r.who,
        detail: `الجهاز ${r.device_id} (${r.who}) أدخل ${r.n} رموزاً خاطئة أو مزوَّرة متتابعة. تخمين للرموز، أو رموز مزوَّرة تُجرَّب.` });
    }

    const staff = await this.db.query(
      `select u.username, count(*)::int as n, count(*) filter (where e.receiver = 'PROXY')::int as proxy,
              count(*) filter (where extract(hour from e.delivered_at at time zone '${TZ}') >= $2 or extract(hour from e.delivered_at at time zone '${TZ}') < $3)::int as night,
              max(e.delivered_at) as at
       from entitlements e join users u on u.id = e.delivered_by where e.campaign_id = $1 and e.status = 'DELIVERED' and e.mode <> 'TRANSFER' group by u.username`,
      [campaignId, L.nightFrom, L.nightTo]);
    const all = staff.rows.reduce((s, r) => ({ n: s.n + r.n, proxy: s.proxy + r.proxy }), { n: 0, proxy: 0 });
    const average = all.n ? all.proxy / all.n : 0;
    for (const r of staff.rows) {
      const share = r.proxy / r.n;
      // موظف وحيد في الحملة لا يُقاس بمعدّل هو صانعه: يكفي فيه تجاوز الحدّ.
      if (r.n >= L.proxyMinDeliveries && share >= L.proxyShare && (staff.rows.length === 1 || share >= 2 * ((all.proxy - r.proxy) / Math.max(1, all.n - r.n)))) {
        out.push({ kind: 'PROXY_HEAVY', severity: 'MEDIUM', title: 'استلام بالوكالة فوق المعتاد', at: iso(r.at), who: r.username,
          detail: `${r.username}: ${r.proxy} من ${r.n} تسليماً بيد وكلاء (${Math.round(share * 100)}%)، ومعدّل الحملة ${Math.round(average * 100)}%.` });
      }
      if (r.night > 0) {
        out.push({ kind: 'OFF_HOURS', severity: 'MEDIUM', title: 'تسليم خارج ساعات الدوام', at: iso(r.at), who: r.username,
          detail: `${r.username} سجّل ${r.night} تسليماً بين الساعة ${L.nightFrom} و${L.nightTo} (بتوقيت بغداد).` });
      }
    }
    return out.sort((a, b) => Number(b.severity === 'HIGH') - Number(a.severity === 'HIGH') || (b.at ?? '').localeCompare(a.at ?? ''));
  }

  /** عدد الإنذارات في كل حملة جارية: لشارة القائمة والرئيسية. */
  async open() {
    const { rows } = await this.db.query("select id, name from campaigns where status = 'ACTIVE' order by created_at desc");
    const out: { campaignId: string; name: string; alerts: number; high: number }[] = [];
    for (const c of rows) {
      const a = await this.alerts(c.id);
      if (a.length) out.push({ campaignId: c.id, name: c.name, alerts: a.length, high: a.filter((x) => x.severity === 'HIGH').length });
    }
    return out;
  }
}
