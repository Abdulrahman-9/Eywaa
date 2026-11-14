import { randomBytes } from 'crypto';
import { Client } from 'pg';
import { entryHash, GENESIS_HASH } from '../audit/audit.service';
import { hashPassword } from '../auth/password';

/**
 * مخرج الطوارئ: مدير نسي كلمته، أو فقد هاتف التحقق، ولا مدير غيره يعيد ضبطه.
 * يُشغَّل على الخادم نفسه ممّن يملك الوصول إليه، ويُكتب في سجل التدقيق سطراً لا يُمحى:
 *   DATABASE_URL=... ADMIN_USERNAME=admin node dist/db/reset-admin.js
 * يطبع كلمة مؤقتة تُغيَّر عند أول دخول، ويفكّ القفل، ويعطّل التحقق بعاملين، وينهي الجلسات القائمة.
 */
async function main() {
  const { DATABASE_URL, ADMIN_USERNAME = 'admin' } = process.env;
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
  const password = randomBytes(12).toString('base64url');
  const hash = await hashPassword(password);
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    await db.query('begin');
    const { rows } = await db.query(
      `update users set password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = null,
              totp_enabled = false, totp_secret_enc = null, totp_last_step = null, token_version = token_version + 1, active = true
       where username = $1 and role = 'ADMIN' returning id`,
      [ADMIN_USERNAME, hash],
    );
    if (!rows[0]) throw new Error(`no admin named "${ADMIN_USERNAME}"`);
    // السطر يدخل السلسلة بقفلها وبصمتها كما يدخلها الخادم، فلا ينكسر التحقق منها.
    await db.query('select pg_advisory_xact_lock($1)', [7_240_001]);
    const last = await db.query('select hash from audit_log order by seq desc limit 1');
    const prev: string = last.rows[0]?.hash ?? GENESIS_HASH;
    const at = new Date().toISOString();
    const entry = { actorId: null, action: 'auth.break_glass', entity: 'user', entityId: rows[0].id as string, payload: { by: 'server console' } };
    await db.query(
      'insert into audit_log (at, actor_id, action, entity, entity_id, payload, prev_hash, hash) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [at, null, entry.action, entry.entity, entry.entityId, JSON.stringify(entry.payload), prev, entryHash(prev, at, entry)],
    );
    await db.query('commit');
    console.log(`admin "${ADMIN_USERNAME}" reset. temporary password (change it at first sign-in): ${password}`);
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
