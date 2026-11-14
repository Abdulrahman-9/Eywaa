import { createHash } from 'crypto';
import { Client } from 'pg';
import { canonical, GENESIS_HASH } from '../audit/audit.service';
import { FieldCrypto } from '../common/crypto';

/**
 * فحص سلامة قاعدة بيانات (الحيّة أو المسترجَعة من نسخة احتياطية):
 * سلسلة التدقيق، وتوازن القيود (مجموعاً، وقيداً قيداً)، وأعداد الجداول. يخرج بغير صفر إن وُجد خلل.
 * وإن أُعطي مفتاحا الحقول تحقّق من أنهما يفكّان ما في القاعدة: نسخة تُسترجع بمفتاح غير مفتاحها لا تنفع.
 *   DATABASE_URL=... [FIELD_ENC_KEY=... FIELD_HMAC_KEY=...] node dist/db/verify.js
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
    // كل قيد بسطرين متساويين: مجموع الدفتر قد يتوازن وفيه قيدان مختلّان يجبر أحدهما الآخر.
    const broken = Number((await db.query(
      `select count(*) as n from ledger_entries e where (select count(*) from ledger_lines l where l.entry_id = e.id) <> 2
          or (select coalesce(sum(l.debit), 0) from ledger_lines l where l.entry_id = e.id) <> e.amount
          or (select coalesce(sum(l.credit), 0) from ledger_lines l where l.entry_id = e.id) <> e.amount`)).rows[0].n);
    let keys: 'ok' | 'mismatch' | 'not checked' | 'nothing encrypted' = 'not checked';
    if (process.env.FIELD_ENC_KEY && process.env.FIELD_HMAC_KEY) {
      const crypto = new FieldCrypto(process.env.FIELD_ENC_KEY, process.env.FIELD_HMAC_KEY);
      const docs = (await db.query('select number_enc from person_documents order by random() limit 25')).rows;
      const rations = (await db.query('select ration_enc as number_enc from families where ration_enc is not null order by random() limit 10')).rows;
      const sample = [...docs, ...rations];
      keys = sample.length ? 'ok' : 'nothing encrypted';
      for (const r of sample) {
        try { crypto.decrypt(r.number_enc); } catch { keys = 'mismatch'; break; }
      }
    }
    const report = {
      auditEntries: rows.length, auditOk: brokenAt === null, auditBrokenAtSeq: brokenAt, lastAuditHash: prev,
      ledgerDebit: ledger.d, ledgerCredit: ledger.c, ledgerBalanced: ledger.d === ledger.c, ledgerEntriesBroken: broken, keys, counts,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.auditOk || !report.ledgerBalanced || broken > 0 || keys === 'mismatch') process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
