import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { normalizeIraqiPhone } from '../common/arabic';
import { Db } from '../db/db.module';

export const donorSchema = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().optional(), note: z.string().trim().max(200).optional() });

@Injectable()
export class DonorsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(input: z.infer<typeof donorSchema>, actor: AuthUser) {
    const phone = input.phone?.trim() ? normalizeIraqiPhone(input.phone) : null;
    if (input.phone?.trim() && !phone) throw new BadRequestException('رقم هاتف عراقي غير صالح');
    try {
      return await this.db.tx(async (c) => {
        const { rows } = await c.query('insert into donors (name, phone, note) values ($1,$2,$3) returning id, name', [input.name, phone, input.note ?? null]);
        await this.audit.append(c, { actorId: actor.id, action: 'donor.create', entity: 'donor', entityId: rows[0].id, payload: { name: input.name } });
        return rows[0];
      });
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('متبرع بهذا الاسم موجود');
      throw err;
    }
  }

  async list() {
    const { rows } = await this.db.query(
      `select d.id, d.name, d.phone, d.note,
              coalesce((select sum(e.amount) from ledger_entries e where e.donor_id = d.id and e.kind = 'RECEIPT' and e.status = 'POSTED'
                          and not exists (select 1 from ledger_entries r where r.reverses = e.id and r.status = 'POSTED')), 0)::bigint as cash,
              (select count(*) from stock_moves m where m.donor_id = d.id and m.kind = 'RECEIPT' and m.status = 'POSTED')::int as in_kind
       from donors d order by d.name`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, note: r.note, cash: Number(r.cash), inKindReceipts: r.in_kind }));
  }

  /**
   * تقرير المتبرع: ما أعطى، وفيمَ صُرف، ومن انتفع.
   * المال في الصندوق الواحد لا يتميّز ديناره عن ديناره، فنصيب المتبرع مما صُرف يُحسب **بالتناسب**:
   * حصته من وارد الصندوق مضروبة فيما صُرف منه. والعوائل تُذكر بأعدادها لا بأسمائها.
   */
  async report(id: string) {
    const donor = (await this.db.query('select id, name from donors where id = $1', [id])).rows[0];
    if (!donor) throw new NotFoundException('المتبرع غير موجود');
    const LIVE = "e.kind = 'RECEIPT' and e.status = 'POSTED' and not exists (select 1 from ledger_entries r where r.reverses = e.id and r.status = 'POSTED')";
    const funds = await this.db.query(
      `select f.id, f.name, p.name as program,
              coalesce(sum(e.amount) filter (where e.donor_id = $1 and ${LIVE}), 0)::bigint as given,
              coalesce(sum(e.amount) filter (where ${LIVE}), 0)::bigint as fund_received,
              coalesce((select sum(x.amount) from ledger_entries x where x.fund_id = f.id and x.status = 'POSTED' and x.kind in ('PAYMENT', 'DISBURSEMENT')
                          and not exists (select 1 from ledger_entries r where r.reverses = x.id and r.status = 'POSTED')), 0)::bigint as fund_spent,
              (select count(distinct en.family_id) from entitlements en join campaigns c on c.id = en.campaign_id
                 where c.fund_id = f.id and en.status = 'DELIVERED')::int as families,
              (select count(*) from housing_projects h where h.fund_id = f.id and h.status in ('ACTIVE', 'DELIVERED'))::int as houses
       from funds f left join programs p on p.id = f.program_id left join ledger_entries e on e.fund_id = f.id
       group by f.id, p.name having coalesce(sum(e.amount) filter (where e.donor_id = $1 and ${LIVE}), 0) > 0 order by f.name`,
      [id],
    );
    const inKind = await this.db.query(
      `select i.name as item, i.unit, sum(m.quantity)::int as quantity,
              coalesce((select sum(s.quantity) from stock_moves s where s.item_id = i.id and s.kind = 'ISSUE' and s.status = 'POSTED'), 0)::int as item_issued,
              coalesce((select sum(s.quantity) from stock_moves s where s.item_id = i.id and s.kind = 'RECEIPT' and s.status = 'POSTED'), 0)::int as item_received
       from stock_moves m join items i on i.id = m.item_id
       where m.donor_id = $1 and m.kind = 'RECEIPT' and m.status = 'POSTED' group by i.id order by i.name`,
      [id],
    );
    const cash = funds.rows.map((r) => {
      const share = Number(r.fund_received) ? Number(r.given) / Number(r.fund_received) : 0;
      return {
        fundId: r.id, fund: r.name, restrictedTo: r.program, given: Number(r.given), sharePercent: Math.round(share * 1000) / 10,
        fundSpent: Number(r.fund_spent), spentShare: Math.min(Math.round(Number(r.fund_spent) * share), Number(r.given)),
        familiesServedByFund: r.families, housesByFund: r.houses,
      };
    });
    return {
      donor: { id: donor.id, name: donor.name },
      totalGiven: cash.reduce((s, c) => s + c.given, 0),
      totalSpentShare: cash.reduce((s, c) => s + c.spentShare, 0),
      cash,
      inKind: inKind.rows.map((r) => ({
        item: r.item, unit: r.unit, quantity: r.quantity,
        distributedShare: r.item_received ? Math.min(Math.round((r.item_issued * r.quantity) / r.item_received), r.quantity) : 0,
      })),
    };
  }
}
