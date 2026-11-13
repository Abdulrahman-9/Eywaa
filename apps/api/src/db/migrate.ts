import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

export async function migrate(databaseUrl: string, dir = join(__dirname, '../../migrations')) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(join(dir, name), 'utf8'));
        await client.query('insert into schema_migrations(name) values ($1)', [name]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  migrate(url).then(
    () => console.log('migrations applied'),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
