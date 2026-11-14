import { createHash } from 'crypto';
import { Client } from 'pg';
import { canonical, GENESIS_HASH } from '../audit/audit.service';

/**
 * فحص سلامة قاعدة بيانات (الحيّة أو المسترجَعة من نسخة احتياطية):
 * سلسلة التدقيق، وتوازن القيود، وأعداد الجداول. يخرج بغير صفر إن وُجد خلل.
 *   DATABASE_URL=... node dist/db/verify.js
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const { rows } = await db.query('select seq, at, actor_id, action, entity, entity_id, payload, prev_hash, hash from audit_log order by seq');
    let prev = GENESIS_HASH;
    let brokenAt: number | null = null;
    for (const r of rows) {
      const expected = createHash('sha256').update(prev)
        .update(canonical({ at: new Date(r.at).toISOString(), actorId: r.actor_id, action: r.action, entity: r.entity, entityId: r.entity_id, payload: r.payload }))
        .digest('hex');
      if (r.prev_hash !== prev || r.hash !== expected) { brokenAt = Number(r.seq); break; }
      prev = r.hash;
    }
    const ledger = (await db.query("select coalesce(sum(l.debit), 0)::text as d, coalesce(sum(l.credit), 0)::text as c from ledger_lines l join ledger_entries e on e.id = l.entry_id where e.status = 'POSTED'")).rows[0];
    const counts: Record<string, number> = {};
    for (const t of ['users', 'families', 'persons', 'person_documents', 'attachments', 'entitlements', 'messages', 'stock_moves', 'ledger_entries', 'housing_projects', 'audit_log']) {
      counts[t] = Number((await db.query(`select count(*) as n from ${t}`)).rows[0].n);
    }
    const report = { auditEntries: rows.length, auditOk: brokenAt === null, auditBrokenAtSeq: brokenAt, lastAuditHash: prev, ledgerDebit: ledger.d, ledgerCredit: ledger.c, ledgerBalanced: ledger.d === ledger.c, counts };
    console.log(JSON.stringify(report, null, 2));
    if (!report.auditOk || !report.ledgerBalanced) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
