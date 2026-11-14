import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { Db } from '../db/db.module';
import { Amount, amountSchema, failures, FamilyFacts, quantity, Rules, rulesSchema } from './rules';

export const programSchema = z.object({
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['MONEY', 'IN_KIND', 'PROJECT', 'SERVICE']),
  unit: z.string().trim().min(1).max(20),
  rules: rulesSchema,
  amount: amountSchema,
  minGapDays: z.number().int().min(0).max(3650).default(0),
  active: z.boolean().default(true),
});
export type ProgramInput = z.infer<typeof programSchema>;

/** وقائع العوائل المعتمدة التي تُبنى عليها الشروط. */
const FACTS_SQL = `
  select f.id, f.family_no, f.housing, f.tags::text[] as tags, sc.class, h.full_name as head_name,
         coalesce((select sum(amount_iqd) from income_sources i where i.family_id = f.id), 0)::int as income,
         count(p.id) filter (where p.status = 'ACTIVE')::int as members,
         count(p.id) filter (where p.status = 'ACTIVE' and p.is_orphan)::int as orphans,
         count(p.id) filter (where p.status = 'ACTIVE' and p.disability is not null)::int as disabled
  from families f left join persons p on p.family_id = f.id
    left join family_scores sc on sc.family_id = f.id
    left join persons h on h.family_id = f.id and h.relation = 'HEAD'
  where f.status = 'APPROVED' and ($1::uuid is null or f.id = $1)
  group by f.id, sc.class, h.full_name`;

const toFacts = (r: any): FamilyFacts => ({
  class: r.class, members: r.members, orphans: r.orphans, disabled: r.disabled, monthlyIncomeIqd: r.income, housing: r.housing, tags: r.tags,
});

export interface Eligible { familyId: string; familyNo: string; headName: string; members: number; quantity: number }

@Injectable()
export class ProgramsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async povertyLine(): Promise<number> {
    return (await this.db.query("select value from settings where key = 'poverty_line_iqd'")).rows[0].value;
  }

  private present(r: any) {
    return {
      id: r.id, name: r.name, kind: r.kind, unit: r.unit, rules: r.rules as Rules, amount: r.amount as Amount,
      minGapDays: r.min_gap_days, active: r.active, createdAt: r.created_at,
    };
  }

  async get(id: string) {
    const { rows } = await this.db.query('select * from programs where id = $1', [id]);
    if (!rows[0]) throw new NotFoundException('البرنامج غير موجود');
    return this.present(rows[0]);
  }

  /** المستحقون لبرنامج الآن، بمقدار كلٍّ منهم. */
  async eligible(program: { rules: Rules; amount: Amount }): Promise<Eligible[]> {
    const line = await this.povertyLine();
    const { rows } = await this.db.query(FACTS_SQL, [null]);
    const out: Eligible[] = [];
    for (const r of rows) {
      const facts = toFacts(r);
      if (failures(program.rules, facts, line).length) continue;
      const q = quantity(program.amount, facts);
      if (q > 0) out.push({ familyId: r.id, familyNo: r.family_no, headName: r.head_name, members: r.members, quantity: q });
    }
    return out.sort((a, b) => a.familyNo.localeCompare(b.familyNo));
  }

  async list() {
    const { rows } = await this.db.query('select * from programs order by active desc, created_at');
    const out = [];
    for (const r of rows) {
      const p = this.present(r);
      const e = p.active ? await this.eligible(p) : [];
      out.push({ ...p, eligibleFamilies: e.length, eligibleQuantity: e.reduce((s, x) => s + x.quantity, 0) });
    }
    return out;
  }

  async eligibleFor(id: string, limit: number) {
    const p = await this.get(id);
    const e = await this.eligible(p);
    return { families: e.length, quantity: e.reduce((s, x) => s + x.quantity, 0), unit: p.unit, sample: e.slice(0, limit) };
  }

  /** معاينة شروط لم تُحفظ بعد: كم عائلة تستحق بها. */
  async preview(body: unknown) {
    const parsed = z.object({ rules: rulesSchema, amount: amountSchema }).safeParse(body);
    if (!parsed.success) throw new BadRequestException({ message: 'شروط غير صالحة', errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const e = await this.eligible(parsed.data);
    return { families: e.length, quantity: e.reduce((s, x) => s + x.quantity, 0) };
  }

  /** ما تستحقه عائلة من كل برنامج فعّال، وسبب ما لا تستحقه. */
  async forFamily(familyId: string) {
    const line = await this.povertyLine();
    const fam = await this.db.query(FACTS_SQL, [familyId]);
    const programs = await this.db.query('select * from programs where active order by created_at');
    if (!fam.rows[0]) return [];
    const facts = toFacts(fam.rows[0]);
    return programs.rows.map((r) => {
      const p = this.present(r);
      const why = failures(p.rules, facts, line);
      const q = why.length ? 0 : quantity(p.amount, facts);
      return { programId: p.id, name: p.name, unit: p.unit, eligible: why.length === 0 && q > 0, quantity: q, reasons: why.length ? why : q === 0 ? ['المقدار صفر'] : [] };
    });
  }

  async create(input: ProgramInput, actor: AuthUser) {
    try {
      return await this.db.tx(async (c) => {
        const { rows } = await c.query(
          'insert into programs (name, kind, unit, rules, amount, min_gap_days, active, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *',
          [input.name, input.kind, input.unit, JSON.stringify(input.rules), JSON.stringify(input.amount), input.minGapDays, input.active, actor.id],
        );
        await this.audit.append(c, { actorId: actor.id, action: 'program.create', entity: 'program', entityId: rows[0].id, payload: input });
        return this.present(rows[0]);
      });
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('برنامج بهذا الاسم موجود');
      throw err;
    }
  }

  async update(id: string, input: ProgramInput, actor: AuthUser) {
    try {
      return await this.db.tx(async (c) => {
        const old = await c.query('select name, kind, unit, rules, amount, min_gap_days, active from programs where id = $1 for update', [id]);
        if (!old.rows[0]) throw new NotFoundException('البرنامج غير موجود');
        const { rows } = await c.query(
          'update programs set name=$2, kind=$3, unit=$4, rules=$5, amount=$6, min_gap_days=$7, active=$8, updated_at=now() where id=$1 returning *',
          [id, input.name, input.kind, input.unit, JSON.stringify(input.rules), JSON.stringify(input.amount), input.minGapDays, input.active],
        );
        await this.audit.append(c, { actorId: actor.id, action: 'program.update', entity: 'program', entityId: id, payload: { before: old.rows[0], after: input } });
        return this.present(rows[0]);
      });
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('برنامج بهذا الاسم موجود');
      throw err;
    }
  }
}
