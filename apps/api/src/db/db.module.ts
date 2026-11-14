import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { Config, loadConfig } from '../config';
import { FieldCrypto } from '../common/crypto';

export const CONFIG = Symbol('CONFIG');

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(CONFIG) config: Config) {
    // كل اتصال يعمل بتوقيت المركز: current_date و date_trunc و ::date تقطع اليوم والشهر حيث يقطعهما أهل المكان، لا عند الثالثة فجراً.
    // والمهلات تمنع أن يعلق الخادم كله إن استُنفد الحوض أو علقت معاملة.
    this.pool = new Pool({
      connectionString: config.DATABASE_URL, options: `-c timezone=${config.APP_TIMEZONE}`,
      connectionTimeoutMillis: 10_000, idle_in_transaction_session_timeout: 60_000, statement_timeout: 60_000,
    });
  }

  query<T extends Record<string, any> = any>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }

  /** ينفّذ الدالة في معاملة واحدة: إمّا أن تتمّ كلها أو لا يبقى منها شيء. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    Db,
    {
      provide: FieldCrypto,
      inject: [CONFIG],
      useFactory: (c: Config) => new FieldCrypto(c.FIELD_ENC_KEY, c.FIELD_HMAC_KEY),
    },
  ],
  exports: [CONFIG, Db, FieldCrypto],
})
export class DbModule {}
