import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { Db } from '../db/db.module';

const amount = z.number().int().min(1).max(1_000_000_000_000);
const text = z.string().trim().min(2).max(200);
export const fundSchema = z.object({ name: z.string().trim().min(2).max(80), programId: z.string().uuid().nullable().optional(), note: z.string().trim().max(200).optional() });
export const receiptSchema = z.object({ fundId: z.string().uuid(), amount, party: text.optional(), description: text, donorId: z.string().uuid().optional() })
  .refine((r) => r.party || r.donorId, 'يلزم ذكر من قُبض منه');
export const paymentSchema = z.object({ fundId: z.string().uuid(), amount, party: text, description: text, category: z.string().trim().min(2).max(60) });
export const custodySchema = z.object({ fundId: z.string().uuid(), userId: z.string().uuid(), amount });
/** expectedBook: الرصيد الذي رآه المحاسب حين عدّ. إن تغيّر قبل وصول طلبه (أو أُرسل الطلب مرتين) رُدّ، فلا يُقيَّد استلام على رصيد لم يره. */
export const receiveSchema = z.object({ fundId: z.string().uuid(), userId: z.string().uuid(), amount, note: z.string().trim().max(200).optional(), expectedBook: z.number().int().optional() });
export const statementSchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export const closeSchema = z.object({ fundId: z.string().uuid(), userId: z.string().uuid(), counted: z.number().int().min(0).max(1_000_000_000_000), expectedBook: z.number().int().optional() });

type Kind = 'RECEIPT' | 'PAYMENT' | 'CUSTODY_ISSUE' | 'CUSTODY_RETURN' | 'DISBURSEMENT' | 'SHORTAGE' | 'OVERAGE' | 'REVERSAL';
/** قفل يجعل القيود واحداً بعد واحد، فلا يُصرف من رصيد لم يثبت. */
const LEDGER_LOCK = 7_240_003;
const custodyAccount = (userId: string) => `CUSTODY:${userId}`;

interface NewEntry {
  kind: Kind; status: 'POSTED' | 'PENDING'; fundId: string; amount: number; description: string; party?: string | null; category?: string | null;
  custodyUser?: string | null; entitlementId?: string | null; reverses?: string | null; debit: string; credit: string; actorId: string;
}

@Injectable()
export class AccountingService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ---------- الأرصدة ----------

  /** رصيد حساب في صندوق، من القيود المثبَّتة فقط. */
  private async balanceOf(c: PoolClient, fundId: string, account: string): Promise<number> {
    const { rows } = await c.query(
      `select coalesce(sum(l.debit - l.credit), 0)::bigint as b from ledger_lines l join ledger_entries e on e.id = l.entry_id
       where e.fund_id = $1 and e.status = 'POSTED' and l.account = $2`,
      [fundId, account],
    );
    return Number(rows[0].b);
  }

  /** ما حُجز من الصندوق ولم يُصرف بعد: حملات مالية جارية، وما بقي من ميزانيات منازل جارية. */
  private async reserved(c: { query: PoolClient['query'] }, fundId: string): Promise<number> {
    const { rows } = await (c as PoolClient).query(
      `select (
         coalesce((select sum(e.quantity) from entitlements e join campaigns c on c.id = e.campaign_id
                   where c.fund_id = $1 and c.status = 'ACTIVE' and e.status = 'PENDING'), 0)
         + coalesce((select sum(s.amount) from housing_stages s join housing_projects p on p.id = s.project_id
                     where p.fund_id = $1 and p.status = 'ACTIVE' and s.status <> 'PAID'), 0)
       )::bigint as r`,
      [fundId],
    );
    return Number(rows[0].r);
  }

  private async insert(c: PoolClient, e: NewEntry): Promise<{ id: string; no: string }> {
    const prefix = e.kind === 'RECEIPT' ? ['ق', 'receipt_no_seq'] : e.kind === 'PAYMENT' ? ['ص', 'payment_no_seq'] : ['ي', 'journal_no_seq'];
    const no = `${prefix[0]}-${(await c.query(`select nextval('${prefix[1]}') as n`)).rows[0].n}`;
    const { rows } = await c.query(
      `insert into ledger_entries (no, kind, status, fund_id, amount, description, party, category, custody_user, entitlement_id, reverses, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [no, e.kind, e.status, e.fundId, e.amount, e.description, e.party ?? null, e.category ?? null, e.custodyUser ?? null, e.entitlementId ?? null, e.reverses ?? null, e.actorId],
    );
    await c.query('insert into ledger_lines (entry_id, account, debit, credit) values ($1,$2,$3,0), ($1,$4,0,$3)', [rows[0].id, e.debit, e.amount, e.credit]);
    return { id: rows[0].id, no };
  }

  private async fund(c: PoolClient, id: string) {
    const { rows } = await c.query('select * from funds where id = $1', [id]);
    if (!rows[0]) throw new NotFoundException('الصندوق غير موجود');
    return rows[0];
  }

  private locked<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.db.tx(async (c) => {
      await c.query('select pg_advisory_xact_lock($1)', [LEDGER_LOCK]);
      return fn(c);
    });
  }

  // ---------- الصناديق ----------

  async createFund(input: z.infer<typeof fundSchema>, actor: AuthUser) {
    try {
      return await this.db.tx(async (c) => {
        const { rows } = await c.query('insert into funds (name, program_id, note) values ($1,$2,$3) returning id', [input.name, input.programId ?? null, input.note ?? null]);
        await this.audit.append(c, { actorId: actor.id, action: 'fund.create', entity: 'fund', entityId: rows[0].id, payload: input });
        return { id: rows[0].id as string };
      });
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('صندوق بهذا الاسم موجود');
      if (err.code === '23503') throw new BadRequestException('البرنامج غير موجود');
      throw err;
    }
  }

  async summary() {
    const funds = await this.db.query(
      `select f.id, f.name, f.note, f.program_id, p.name as program,
              coalesce(sum(l.debit - l.credit) filter (where l.account = 'CASH'), 0)::bigint as cash,
              coalesce(sum(l.debit - l.credit) filter (where l.account like 'CUSTODY:%'), 0)::bigint as custody
       from funds f left join programs p on p.id = f.program_id
         left join ledger_entries e on e.fund_id = f.id and e.status = 'POSTED' left join ledger_lines l on l.entry_id = e.id
       where f.active group by f.id, p.name order by f.created_at`,
    );
    // من سطور الدفتر نفسها، كميزان المراجعة: فيدخل العكس والعجز والزيادة، ولا يختلف الرقمان.
    const month = await this.db.query(
      `select coalesce(sum(l.credit - l.debit) filter (where l.account = 'INCOME'), 0)::bigint as received,
              coalesce(sum(l.debit - l.credit) filter (where l.account like 'EXPENSE:%'), 0)::bigint as spent
       from ledger_lines l join ledger_entries e on e.id = l.entry_id
       where e.status = 'POSTED' and coalesce(e.decided_at, e.created_at) >= date_trunc('month', now())`,
    );
    const pending = await this.db.query("select count(*)::int as n from ledger_entries where status = 'PENDING'");
    const out = [];
    for (const f of funds.rows) {
      const reserved = await this.reserved(this.db as never, f.id);
      out.push({ id: f.id, name: f.name, note: f.note, programId: f.program_id, program: f.program, cash: Number(f.cash), custody: Number(f.custody), reserved, available: Number(f.cash) + Number(f.custody) - reserved });
    }
    return { funds: out, receivedThisMonth: Number(month.rows[0].received), spentThisMonth: Number(month.rows[0].spent), pendingEntries: pending.rows[0].n };
  }

  // ---------- السندات ----------

  receipt(input: z.infer<typeof receiptSchema>, actor: AuthUser) {
    return this.locked(async (c) => {
      await this.fund(c, input.fundId);
      let party = input.party ?? null;
      if (input.donorId) {
        const d = await c.query('select name from donors where id = $1', [input.donorId]);
        if (!d.rows[0]) throw new BadRequestException('المتبرع غير موجود');
        party = d.rows[0].name;
      }
      const e = await this.insert(c, { kind: 'RECEIPT', status: 'POSTED', fundId: input.fundId, amount: input.amount, description: input.description, party, debit: 'CASH', credit: 'INCOME', actorId: actor.id });
      if (input.donorId) await c.query('update ledger_entries set donor_id = $2 where id = $1', [e.id, input.donorId]);
      await this.audit.append(c, { actorId: actor.id, action: 'ledger.receipt', entity: 'ledger_entry', entityId: e.id, payload: { ...input, no: e.no } });
      return { ...e, status: 'POSTED' };
    });
  }

  /** سند الصرف لا يثبت حتى يعتمده موظف آخر. والصندوق المقيَّد ببرنامج لا يُصرف منه في غيره. */
  payment(input: z.infer<typeof paymentSchema>, actor: AuthUser) {
    return this.locked(async (c) => {
      const fund = await this.fund(c, input.fundId);
      if (fund.program_id) throw new ConflictException(`«${fund.name}» صندوق مقيَّد ببرنامجه، ولا يُصرف منه إلا في حملات ذلك البرنامج`);
      const e = await this.insert(c, { kind: 'PAYMENT', status: 'PENDING', fundId: input.fundId, amount: input.amount, description: input.description, party: input.party, category: input.category, debit: `EXPENSE:${input.category}`, credit: 'CASH', actorId: actor.id });
      await this.audit.append(c, { actorId: actor.id, action: 'ledger.payment', entity: 'ledger_entry', entityId: e.id, payload: { ...input, no: e.no } });
      return { ...e, status: 'PENDING' };
    });
  }

  decide(id: string, approve: boolean, note: string | undefined, actor: AuthUser) {
    return this.locked(async (c) => {
      const { rows } = await c.query('select * from ledger_entries where id = $1 for update', [id]);
      const e = rows[0];
      if (!e) throw new NotFoundException('القيد غير موجود');
      if (e.status !== 'PENDING') throw new ConflictException('فُصل في هذا القيد من قبل');
      if (e.created_by === actor.id) throw new ForbiddenException('لا يعتمد الموظف قيداً سجّله بنفسه');
      // ولا قيداً يمسّ ذمته هو: عجز عهدته أو زيادتها أو عكس ما قُيّد عليها.
      const lines = (await c.query('select account, credit from ledger_lines where entry_id = $1', [id])).rows;
      if (e.custody_user === actor.id || lines.some((l) => l.account === custodyAccount(actor.id))) throw new ForbiddenException('لا يعتمد الموظف قيداً في ذمته هو');
      if (!approve && !note) throw new BadRequestException('يلزم ذكر سبب الرفض');
      if (approve && e.kind === 'PAYMENT') await this.requireFreeCash(c, e.fund_id, Number(e.amount));
      if (approve && e.kind === 'REVERSAL') {
        // عكس سند قبض يُخرج المال من حيث دخل (نقد الصندوق أو ذمة من تسلّمه). فإن كان قد صُرف أو سُلّم لم يبقَ ما يُعكس.
        const from = lines.find((l) => Number(l.credit) > 0 && (l.account === 'CASH' || l.account.startsWith('CUSTODY:')));
        if (from) {
          const have = await this.balanceOf(c, e.fund_id, from.account);
          if (have < Number(e.amount)) throw new ConflictException(`لا يُعكس الآن: ${from.account === 'CASH' ? 'نقد الصندوق' : 'ذمة من تسلّم المبلغ'} فيه ${have.toLocaleString('en-US')} والمطلوب ${Number(e.amount).toLocaleString('en-US')}. المبلغ صُرف أو سُلّم بعد قيده.`);
        }
      }
      await c.query('update ledger_entries set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1', [id, approve ? 'POSTED' : 'REJECTED', actor.id, note ?? null]);
      await this.audit.append(c, { actorId: actor.id, action: approve ? 'ledger.approve' : 'ledger.reject', entity: 'ledger_entry', entityId: id, payload: { no: e.no, kind: e.kind, amount: Number(e.amount), note: note ?? null } });
      return { id, no: e.no, status: approve ? 'POSTED' : 'REJECTED' };
    });
  }

  /** نقد الصندوق الحاضر يكفي: لما هو صرف لالتزام محجوز له (دفعة بناء، كشف حوالات)، أو نقل إلى عهدة لا ينقص مال الصندوق. */
  private async requireCash(c: PoolClient, fundId: string, need: number) {
    const cash = await this.balanceOf(c, fundId, 'CASH');
    if (cash < need) throw new ConflictException(`نقد الصندوق لا يكفي: فيه ${cash.toLocaleString('en-US')} والمطلوب ${need.toLocaleString('en-US')}`);
  }

  /** النقد الحرّ: الحاضر يكفي، وما يبقى بعد الصرف (نقداً وعُهداً) يغطي ما حُجز لحملات جارية ومنازل تُبنى. لسند الصرف الذي لا التزام محجوزاً له. */
  private async requireFreeCash(c: PoolClient, fundId: string, need: number) {
    await this.requireCash(c, fundId, need);
    const held = Number((await c.query(
      `select coalesce(sum(l.debit - l.credit), 0)::bigint as b from ledger_lines l join ledger_entries e on e.id = l.entry_id
       where e.fund_id = $1 and e.status = 'POSTED' and (l.account = 'CASH' or l.account like 'CUSTODY:%')`, [fundId])).rows[0].b);
    const reserved = await this.reserved(c, fundId);
    if (held - reserved < need) throw new ConflictException(`لا يُصرف: في الصندوق ${held.toLocaleString('en-US')}، منها ${reserved.toLocaleString('en-US')} محجوزة لحملات جارية أو منازل تُبنى، والمطلوب ${need.toLocaleString('en-US')}`);
  }

  /** الصندوق المقيَّد ببرنامج لا يُصرف منه إلا في حملات برنامجه: لا بناء ولا غيره. */
  async requireUnrestricted(c: PoolClient, fundId: string, what: string) {
    const fund = await this.fund(c, fundId);
    if (fund.program_id) {
      const program = (await c.query('select name from programs where id = $1', [fund.program_id])).rows[0];
      throw new ConflictException(`«${fund.name}» مقيَّد ببرنامج «${program?.name ?? ''}»: لا يُصرف منه ${what}`);
    }
  }

  /** القيد لا يُحذف: يُعكس بقيد مقابل ينتظر الاعتماد. */
  reverse(id: string, reason: string, actor: AuthUser) {
    return this.locked(async (c) => {
      const { rows } = await c.query('select * from ledger_entries where id = $1', [id]);
      const e = rows[0];
      if (!e) throw new NotFoundException('القيد غير موجود');
      if (e.status !== 'POSTED' || !['RECEIPT', 'PAYMENT'].includes(e.kind)) throw new ConflictException('لا يُعكس إلا سند قبض أو صرف مثبَّت');
      // قيد أنشأه مستند آخر لا يُعكس وحده، وإلا بقي المستند يقول «صُرف» والدفتر يقول «لم يُصرف».
      const owner = (await c.query(
        `select (select 'دفعة مرحلة بناء' from housing_stages where payment_entry = $1 limit 1) as stage,
                (select 'كشف دفع بالحوالة' from payout_batches where entry_id = $1 limit 1) as payout`, [id])).rows[0];
      if (owner.stage || owner.payout) throw new ConflictException(`هذا القيد قيّده ${owner.stage ?? owner.payout}: لا يُعكس من هنا`);
      const lines = await c.query('select account, debit from ledger_lines where entry_id = $1', [id]);
      const debit = lines.rows.find((l) => Number(l.debit) > 0)!.account;
      const credit = lines.rows.find((l) => Number(l.debit) === 0)!.account;
      try {
        const r = await this.insert(c, { kind: 'REVERSAL', status: 'PENDING', fundId: e.fund_id, amount: Number(e.amount), description: `عكس ${e.no}: ${reason}`, party: e.party, reverses: id, debit: credit, credit: debit, actorId: actor.id });
        await this.audit.append(c, { actorId: actor.id, action: 'ledger.reverse', entity: 'ledger_entry', entityId: r.id, payload: { reverses: e.no, reason } });
        return { ...r, status: 'PENDING' };
      } catch (err: any) {
        if (err.code === '23505') throw new ConflictException('لهذا القيد قيد عكس من قبل');
        throw err;
      }
    });
  }

  // ---------- العهدة ----------

  /** يسلّم المحاسب نقداً من الصندوق إلى أمين صندوق في نقطة. */
  issueCustody(input: z.infer<typeof custodySchema>, actor: AuthUser) {
    return this.locked(async (c) => {
      await this.fund(c, input.fundId);
      if (input.userId === actor.id) throw new ForbiddenException('لا يسلّم المحاسب عهدة لنفسه');
      const user = await c.query('select username from users where id = $1 and active', [input.userId]);
      if (!user.rows[0]) throw new BadRequestException('الموظف غير موجود أو معطَّل');
      await this.requireCash(c, input.fundId, input.amount);
      const e = await this.insert(c, { kind: 'CUSTODY_ISSUE', status: 'POSTED', fundId: input.fundId, amount: input.amount, description: `عهدة إلى ${user.rows[0].username}`, custodyUser: input.userId, debit: custodyAccount(input.userId), credit: 'CASH', actorId: actor.id });
      await this.audit.append(c, { actorId: actor.id, action: 'custody.issue', entity: 'ledger_entry', entityId: e.id, payload: { ...input, no: e.no } });
      return e;
    });
  }

  /**
   * إقفال العهدة: يُعدّ النقد فيُقابَل بالدفتر. ما عُدَّ يرجع إلى الصندوق،
   * والفرق يصير قيد عجز أو زيادة ينتظر اعتماد موظف آخر.
   */
  closeCustody(input: z.infer<typeof closeSchema>, actor: AuthUser) {
    const userId = input.userId;
    // من يحمل العهدة لا يشهد بما ردّ منها: يعدّها ويقفلها محاسب غيره.
    if (userId === actor.id) throw new ForbiddenException('لا يُقفل الموظف عهدة نفسه');
    return this.locked(async (c) => {
      await this.fund(c, input.fundId);
      const book = await this.balanceOf(c, input.fundId, custodyAccount(userId));
      if (input.expectedBook !== undefined && input.expectedBook !== book) throw new ConflictException(`تغيّر رصيد العهدة: هو الآن ${book.toLocaleString('en-US')}. أعد العدّ عليه.`);
      const open = await c.query("select no from ledger_entries where fund_id = $1 and custody_user = $2 and kind in ('SHORTAGE', 'OVERAGE') and status = 'PENDING' limit 1", [input.fundId, userId]);
      if (open.rows[0]) throw new ConflictException(`لهذه العهدة فرق ينتظر الاعتماد (${open.rows[0].no}): افصل فيه قبل عدّ جديد`);
      if (book === 0 && input.counted === 0) throw new ConflictException('لا رصيد في هذه العهدة ولا نقد: لا شيء يُقفل');
      const diff = input.counted - book;
      if (input.counted > 0) {
        await this.insert(c, { kind: 'CUSTODY_RETURN', status: 'POSTED', fundId: input.fundId, amount: input.counted, description: 'إرجاع العهدة عند الإقفال', custodyUser: userId, debit: 'CASH', credit: custodyAccount(userId), actorId: actor.id });
      }
      let pending: string | null = null;
      if (diff < 0) {
        pending = (await this.insert(c, { kind: 'SHORTAGE', status: 'PENDING', fundId: input.fundId, amount: -diff, description: 'عجز في العهدة عند الإقفال', custodyUser: userId, debit: 'EXPENSE:عجز العهد', credit: custodyAccount(userId), actorId: actor.id })).no;
      } else if (diff > 0) {
        pending = (await this.insert(c, { kind: 'OVERAGE', status: 'PENDING', fundId: input.fundId, amount: diff, description: 'زيادة في العهدة عند الإقفال', custodyUser: userId, debit: custodyAccount(userId), credit: 'INCOME', actorId: actor.id })).no;
      }
      await this.audit.append(c, { actorId: actor.id, action: 'custody.close', entity: 'fund', entityId: input.fundId, payload: { userId, book, counted: input.counted, difference: diff } });
      return { book, counted: input.counted, difference: diff, pendingEntry: pending };
    });
  }

  /**
   * مال تسلّمه موظف في الميدان (تحصيل صندوق تبرعات، أو تبرع نقدي): إيراد للصندوق يدخل ذمته.
   * يُقيَّد بقوله هو: من سجّل على نفسه مالاً صار مطلوباً به، فلا مصلحة له في الزيادة؛ والنقص يكشفه إشعار المتبرع وعدّ الصندوق.
   * يُستدعى داخل معاملة العملية التي أنشأته.
   */
  async collect(c: PoolClient, p: { fundId: string; amount: number; holderId: string | null; description: string; party?: string | null; donorId?: string | null; category: string; actorId: string }) {
    await c.query('select pg_advisory_xact_lock($1)', [LEDGER_LOCK]);
    await this.fund(c, p.fundId);
    const e = await this.insert(c, { kind: 'RECEIPT', status: 'POSTED', fundId: p.fundId, amount: p.amount, description: p.description, party: p.party ?? null, category: p.category, custodyUser: p.holderId, debit: p.holderId ? custodyAccount(p.holderId) : 'CASH', credit: 'INCOME', actorId: p.actorId });
    if (p.donorId) await c.query('update ledger_entries set donor_id = $2 where id = $1', [e.id, p.donorId]);
    return e;
  }

  /**
   * استلام ذمة: يسلّم الموظف نقداً مما في ذمته فيدخل نقد الصندوق. جزئي: يبقى الباقي في ذمته.
   * لا يُستلم أكثر مما في الدفتر؛ الزيادة والعجز يُسوَّيان بإقفال الذمة.
   */
  receiveCustody(input: z.infer<typeof receiveSchema>, actor: AuthUser) {
    if (input.userId === actor.id) throw new ForbiddenException('لا يستلم الموظف ذمة نفسه');
    return this.locked(async (c) => {
      await this.fund(c, input.fundId);
      const holder = (await c.query('select full_name from users where id = $1', [input.userId])).rows[0];
      if (!holder) throw new BadRequestException('الموظف غير موجود');
      const book = await this.balanceOf(c, input.fundId, custodyAccount(input.userId));
      if (input.expectedBook !== undefined && input.expectedBook !== book) throw new ConflictException(`تغيّر ما في ذمته: هو الآن ${book.toLocaleString('en-US')}. راجع قبل أن تسجّل.`);
      if (input.amount > book) throw new ConflictException(`في ذمته ${book.toLocaleString('en-US')} والمستلَم ${input.amount.toLocaleString('en-US')}. إن زاد النقد عن الدفتر فأقفل الذمة بالعدّ.`);
      const e = await this.insert(c, { kind: 'CUSTODY_RETURN', status: 'POSTED', fundId: input.fundId, amount: input.amount, description: `استلام من ذمة ${holder.full_name}${input.note ? `: ${input.note}` : ''}`, custodyUser: input.userId, debit: 'CASH', credit: custodyAccount(input.userId), actorId: actor.id });
      await this.audit.append(c, { actorId: actor.id, action: 'custody.receive', entity: 'ledger_entry', entityId: e.id, payload: { ...input, no: e.no, book, remaining: book - input.amount } });
      return { ...e, book, remaining: book - input.amount };
    });
  }

  /** كشف ذمة موظف: كل ما دخلها وخرج منها برصيد جارٍ، في كل الصناديق. */
  async custodyStatement(userId: string, limit = 200) {
    const { rows } = await this.db.query(
      `select e.id, e.no, e.kind, e.status, e.description, e.party, e.created_at, f.id as fund_id, f.name as fund, l.debit, l.credit, u.username as by
       from ledger_lines l join ledger_entries e on e.id = l.entry_id join funds f on f.id = e.fund_id join users u on u.id = e.created_by
       where l.account = $1 and e.status in ('POSTED', 'PENDING') order by e.created_at, e.no`, [custodyAccount(userId)]);
    let balance = 0;
    const lines = rows.map((r) => {
      const posted = r.status === 'POSTED';
      if (posted) balance += Number(r.debit) - Number(r.credit);
      return { id: r.id, no: r.no, kind: r.kind, pending: !posted, description: r.description, party: r.party, at: r.created_at, fundId: r.fund_id, fund: r.fund, in: Number(r.debit), out: Number(r.credit), balance, by: r.by };
    });
    const byFund = new Map<string, { fundId: string; fund: string; balance: number }>();
    for (const l of lines) {
      if (l.pending) continue;
      const f = byFund.get(l.fundId) ?? { fundId: l.fundId, fund: l.fund, balance: 0 };
      f.balance += l.in - l.out;
      byFund.set(l.fundId, f);
    }
    return { balance, funds: [...byFund.values()].filter((f) => f.balance !== 0), lines: lines.slice(-limit).reverse() };
  }

  /** كشف حساب الصندوق: حركات نقده برصيد جارٍ، في مدة. ما قبلها رصيد افتتاحي. */
  async fundStatement(fundId: string, from?: string, to?: string) {
    const fund = (await this.db.query('select id, name from funds where id = $1', [fundId])).rows[0];
    if (!fund) throw new NotFoundException('الصندوق غير موجود');
    const opening = from ? Number((await this.db.query(
      `select coalesce(sum(l.debit - l.credit), 0)::bigint as b from ledger_lines l join ledger_entries e on e.id = l.entry_id
       where e.fund_id = $1 and e.status = 'POSTED' and l.account = 'CASH' and coalesce(e.decided_at, e.created_at) < $2::date`, [fundId, from])).rows[0].b) : 0;
    const { rows } = await this.db.query(
      `select e.id, e.no, e.kind, e.description, e.party, e.category, coalesce(e.decided_at, e.created_at) as created_at, l.debit, l.credit, u.username as by, du.username as approved_by
       from ledger_lines l join ledger_entries e on e.id = l.entry_id join users u on u.id = e.created_by left join users du on du.id = e.decided_by
       where e.fund_id = $1 and e.status = 'POSTED' and l.account = 'CASH'
         and ($2::date is null or coalesce(e.decided_at, e.created_at) >= $2::date) and ($3::date is null or coalesce(e.decided_at, e.created_at) < $3::date + 1)
       order by coalesce(e.decided_at, e.created_at), e.no`, [fundId, from ?? null, to ?? null]);
    let balance = opening, received = 0, paid = 0;
    const lines = rows.map((r) => {
      const i = Number(r.debit), o = Number(r.credit);
      balance += i - o; received += i; paid += o;
      return { id: r.id, no: r.no, kind: r.kind, description: r.description, party: r.party, category: r.category, at: r.created_at, in: i, out: o, balance, by: r.by, approvedBy: r.approved_by };
    });
    // من أين جاء المال وفيمَ ذهب، في المدة نفسها. الإيراد يُحسب يوم قُيّد ولو كان بعدُ في ذمة محصِّله.
    // تُجمع من سطور الدفتر، فتوافق ميزان المراجعة: قيد العكس ينقص بابه في مدة العكس، ولا يُمحى أصله من مدة مضت.
    const cats = await this.db.query(
      `select (l.account = 'INCOME') as income,
              case when l.account <> 'INCOME' then substr(l.account, 9)
                   when e.kind = 'OVERAGE' then 'OVERAGE'
                   else coalesce(e.category, o.category, case when coalesce(e.donor_id, o.donor_id) is not null then 'DONOR' else 'DIRECT' end) end as category,
              sum(case when l.account = 'INCOME' then l.credit - l.debit else l.debit - l.credit end)::bigint as amount,
              count(*) filter (where e.kind <> 'REVERSAL')::int as n
       from ledger_lines l join ledger_entries e on e.id = l.entry_id left join ledger_entries o on o.id = e.reverses
       where e.fund_id = $1 and e.status = 'POSTED' and (l.account = 'INCOME' or l.account like 'EXPENSE:%')
         and ($2::date is null or coalesce(e.decided_at, e.created_at) >= $2::date) and ($3::date is null or coalesce(e.decided_at, e.created_at) < $3::date + 1)
       group by 1, 2 order by 3 desc`, [fundId, from ?? null, to ?? null]);
    const custody = Number((await this.db.query(
      `select coalesce(sum(l.debit - l.credit), 0)::bigint as b from ledger_lines l join ledger_entries e on e.id = l.entry_id
       where e.fund_id = $1 and e.status = 'POSTED' and l.account like 'CUSTODY:%'`, [fundId])).rows[0].b);
    const group = (income: boolean) => cats.rows.filter((r) => r.income === income && Number(r.amount) !== 0)
      .map((r) => ({ category: r.category as string, amount: Number(r.amount), count: r.n as number }));
    return { fundId, fund: fund.name as string, from: from ?? null, to: to ?? null, opening, received, paid, closing: balance, custody, income: group(true), spending: group(false), lines };
  }

  /** سند واحد بكل ما فيه، للطباعة. */
  async voucher(id: string) {
    const { rows } = await this.db.query(
      `select e.*, f.name as fund, u.full_name as created_by_name, du.full_name as decided_by_name, cu.full_name as custody_name, d.name as donor
       from ledger_entries e join funds f on f.id = e.fund_id join users u on u.id = e.created_by left join users du on du.id = e.decided_by
         left join users cu on cu.id = e.custody_user left join donors d on d.id = e.donor_id where e.id = $1`, [id]);
    const e = rows[0];
    if (!e) throw new NotFoundException('السند غير موجود');
    const lines = await this.db.query('select account, debit, credit from ledger_lines where entry_id = $1 order by debit desc', [id]);
    return {
      id: e.id, no: e.no, kind: e.kind, status: e.status, fund: e.fund, amount: Number(e.amount), description: e.description, party: e.party ?? e.donor, category: e.category,
      at: e.created_at, createdBy: e.created_by_name, decidedBy: e.decided_by_name, decidedAt: e.decided_at, custodyOf: e.custody_name,
      lines: lines.rows.map((l) => ({ account: l.account as string, debit: Number(l.debit), credit: Number(l.credit) })),
    };
  }

  async custodies() {
    const { rows } = await this.db.query(
      `select f.id as fund_id, f.name as fund, u.id as user_id, u.username, u.full_name, sum(l.debit - l.credit)::bigint as balance
       from ledger_lines l join ledger_entries e on e.id = l.entry_id join funds f on f.id = e.fund_id
         join users u on l.account = 'CUSTODY:' || u.id::text
       where e.status = 'POSTED' group by f.id, u.id having sum(l.debit - l.credit) <> 0 order by f.name, u.username`,
    );
    return rows.map((r) => ({ fundId: r.fund_id, fund: r.fund, userId: r.user_id, username: r.username, fullName: r.full_name, balance: Number(r.balance) }));
  }

  // ---------- الحملات المالية ----------

  /** عند اعتماد حملة مالية: صندوقها يوافق برنامجها، وفيه ما يكفيها بعد ما حُجز لغيرها. */
  async checkCampaignFund(c: PoolClient, fundId: string, programId: string, total: number) {
    await c.query('select pg_advisory_xact_lock($1)', [LEDGER_LOCK]);
    const fund = await this.fund(c, fundId);
    if (fund.program_id && fund.program_id !== programId) throw new ConflictException(`«${fund.name}» مقيَّد ببرنامج آخر، ولا تُصرف منه هذه الحملة`);
    const have = (await this.balanceOf(c, fundId, 'CASH')) + Number((await c.query(
      `select coalesce(sum(l.debit - l.credit), 0)::bigint as b from ledger_lines l join ledger_entries e on e.id = l.entry_id
       where e.fund_id = $1 and e.status = 'POSTED' and l.account like 'CUSTODY:%'`, [fundId])).rows[0].b);
    const free = have - (await this.reserved(c, fundId));
    if (free < total) throw new ConflictException(`الصندوق لا يكفي الحملة: المتاح فيه ${free.toLocaleString('en-US')} والمطلوب ${total.toLocaleString('en-US')}`);
  }

  /**
   * كل صرف نقدي في التوزيع له قيد: من عهدة موظف التوزيع إلى مصروف المساعدات.
   * يُسجَّل ولو تجاوز العهدة: المال خرج، والعجز يظهر عند الإقفال.
   */
  async disburseForDelivery(c: PoolClient, d: { entitlementId: string; campaignId: string; quantity: number; actorId: string; familyNo: string }) {
    const camp = (await c.query('select c.fund_id, c.name, p.kind from campaigns c join programs p on p.id = c.program_id where c.id = $1', [d.campaignId])).rows[0];
    if (!camp?.fund_id || camp.kind !== 'MONEY') return;
    const exists = await c.query('select 1 from ledger_entries where entitlement_id = $1', [d.entitlementId]);
    if (exists.rowCount) return;
    await c.query('select pg_advisory_xact_lock($1)', [LEDGER_LOCK]);
    await this.insert(c, { kind: 'DISBURSEMENT', status: 'POSTED', fundId: camp.fund_id, amount: d.quantity, description: `${camp.name}: العائلة ${d.familyNo}`, party: d.familyNo, category: 'مساعدات', custodyUser: d.actorId, entitlementId: d.entitlementId, debit: 'EXPENSE:مساعدات', credit: custodyAccount(d.actorId), actorId: d.actorId });
  }

  /** المتاح في الصندوق (نقده وعُهده ناقصاً المحجوز) يكفي هذا المبلغ، وإلا رُفض. */
  async requireAvailable(c: PoolClient, fundId: string, need: number, what: string) {
    await c.query('select pg_advisory_xact_lock($1)', [LEDGER_LOCK]);
    const fund = await this.fund(c, fundId);
    const have = Number((await c.query(
      `select coalesce(sum(l.debit - l.credit), 0)::bigint as b from ledger_lines l join ledger_entries e on e.id = l.entry_id
       where e.fund_id = $1 and e.status = 'POSTED' and (l.account = 'CASH' or l.account like 'CUSTODY:%')`, [fundId])).rows[0].b);
    const free = have - (await this.reserved(c, fundId));
    if (free < need) throw new ConflictException(`«${fund.name}» لا يكفي ${what}: المتاح فيه ${free.toLocaleString('en-US')} والمطلوب ${need.toLocaleString('en-US')}`);
  }

  /**
   * صرف مثبَّت من نقد صندوق، لعملية اعتُمدت في موضعها (كدفعة مرحلة بناء تحقق منها موظف واعتمدها آخر).
   * يُستدعى داخل معاملة تلك العملية.
   */
  async payFromFund(c: PoolClient, p: { fundId: string; amount: number; category: string; party: string; description: string; actorId: string }) {
    await c.query('select pg_advisory_xact_lock($1)', [LEDGER_LOCK]);
    await this.requireCash(c, p.fundId, p.amount);
    return this.insert(c, { kind: 'PAYMENT', status: 'POSTED', fundId: p.fundId, amount: p.amount, description: p.description, party: p.party, category: p.category, debit: `EXPENSE:${p.category}`, credit: 'CASH', actorId: p.actorId });
  }

  // ---------- التقارير ----------

  async entries(params: { status?: string; fundId?: string }) {
    const { rows } = await this.db.query(
      `select e.id, e.no, e.kind, e.status, e.amount, e.description, e.party, e.category, e.created_at, f.name as fund, u.username as created_by, du.username as decided_by,
              exists (select 1 from ledger_entries r where r.reverses = e.id and r.status <> 'REJECTED') as reversed
       from ledger_entries e join funds f on f.id = e.fund_id join users u on u.id = e.created_by left join users du on du.id = e.decided_by
       where ($1::entry_status is null or e.status = $1) and ($2::uuid is null or e.fund_id = $2) and e.kind <> 'DISBURSEMENT'
       -- ما ينتظر الاعتماد أولاً، مهما قدُم: المعلّق القديم لا يخرج من القائمة بكثرة ما بعده.
       order by (e.status = 'PENDING') desc, e.created_at desc limit 100`,
      [params.status ?? null, params.fundId ?? null],
    );
    return rows.map((r) => ({ id: r.id, no: r.no, kind: r.kind, status: r.status, amount: Number(r.amount), description: r.description, party: r.party, category: r.category, createdAt: r.created_at, fund: r.fund, createdBy: r.created_by, decidedBy: r.decided_by, reversed: r.reversed }));
  }

  /** ميزان المراجعة: مجموع المدين = مجموع الدائن، دائماً. */
  async trialBalance() {
    const { rows } = await this.db.query(
      `select f.name as fund, case when l.account like 'CUSTODY:%' then 'عهد الأمناء' when l.account = 'CASH' then 'النقد'
                when l.account = 'INCOME' then 'الإيرادات والتبرعات' else 'مصروف: ' || substr(l.account, 9) end as account,
              sum(l.debit)::bigint as debit, sum(l.credit)::bigint as credit
       from ledger_lines l join ledger_entries e on e.id = l.entry_id join funds f on f.id = e.fund_id
       where e.status = 'POSTED' group by f.name, 2 order by f.name, 2`,
    );
    const lines = rows.map((r) => ({ fund: r.fund, account: r.account, debit: Number(r.debit), credit: Number(r.credit), balance: Number(r.debit) - Number(r.credit) }));
    const debit = lines.reduce((s, l) => s + l.debit, 0);
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    return { lines, totalDebit: debit, totalCredit: credit, balanced: debit === credit };
  }
}
