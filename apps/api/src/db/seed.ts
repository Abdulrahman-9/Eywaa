import { Client } from 'pg';
import { hashPassword } from '../auth/password';

/** ينشئ حساب المدير الأول إن لم يكن في النظام مدير. */
async function main() {
  const { DATABASE_URL, ADMIN_USERNAME = 'admin', ADMIN_PASSWORD } = process.env;
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    throw new Error('ADMIN_PASSWORD is required (12 characters at least)');
  }
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const existing = await client.query("select 1 from users where role = 'ADMIN' limit 1");
    if (existing.rowCount) {
      console.log('an admin already exists; nothing to do');
      return;
    }
    await client.query(
      // كلمة الإنشاء تبقى في ملف البيئة على الخادم: يغيّرها المدير عند أول دخول فلا تنفع من قرأ الملف بعدها.
      "insert into users (username, full_name, password_hash, role, must_change_password) values ($1, $2, $3, 'ADMIN', true)",
      [ADMIN_USERNAME, 'مدير النظام', await hashPassword(ADMIN_PASSWORD)],
    );
    console.log(`admin "${ADMIN_USERNAME}" created`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
