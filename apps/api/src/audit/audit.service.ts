import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PoolClient } from 'pg';
import { Db } from '../db/db.module';

export const GENESIS_HASH = '0'.repeat(64);
const CHAIN_LOCK = 7_240_001;

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entity: string;
  entityId: string;
  payload?: Record<string, unknown>;
}

/** JSON بمفاتيح مرتّبة، لتكون البصمة واحدة مهما اختلف ترتيب الحفظ. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export function entryHash(prevHash: string, at: string, e: Required<AuditEntry>): string {
  return createHash('sha256')
    .update(prevHash)
    .update(canonical({ at, actorId: e.actorId, action: e.action, entity: e.entity, entityId: e.entityId, payload: e.payload }))
    .digest('hex');
}

@Injectable()
export class AuditService {
  constructor(@Inject(Db) private readonly db: Db) {}

  /**
   * يضيف سطراً إلى السلسلة داخل معاملة العملية نفسها: فإن فشلت العملية لم يُكتب السطر،
   * وإن فشل السطر لم تتمّ العملية.
   */
  async append(client: PoolClient, entry: AuditEntry): Promise<void> {
    // الحمولة تُحوَّل إلى صيغتها المحفوظة قبل حساب البصمة (التاريخ يصير نصاً مثلاً)،
    // وإلا اختلفت البصمة عند إعادة الحساب من القاعدة فبدا السجل معبوثاً به وهو سليم.
    const full = { ...entry, payload: JSON.parse(JSON.stringify(entry.payload ?? {})) as Record<string, unknown> };
    // قفل يجعل الإضافة إلى السلسلة واحدة بعد واحدة.
    await client.query('select pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
    const last = await client.query('select hash from audit_log order by seq desc limit 1');
    const prevHash: string = last.rows[0]?.hash ?? GENESIS_HASH;
    const at = new Date().toISOString();
    await client.query(
      `insert into audit_log (at, actor_id, action, entity, entity_id, payload, prev_hash, hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [at, full.actorId, full.action, full.entity, full.entityId, JSON.stringify(full.payload), prevHash, entryHash(prevHash, at, full)],
    );
  }

  /** يعيد حساب السلسلة كلها؛ ويذكر أول سطر انكسرت عنده إن وُجد. */
  async verify(): Promise<{ ok: boolean; entries: number; brokenAtSeq: number | null }> {
    const { rows } = await this.db.query(
      'select seq, at, actor_id, action, entity, entity_id, payload, prev_hash, hash from audit_log order by seq',
    );
    let prev = GENESIS_HASH;
    for (const r of rows) {
      const expected = entryHash(prev, new Date(r.at).toISOString(), {
        actorId: r.actor_id, action: r.action, entity: r.entity, entityId: r.entity_id, payload: r.payload,
      });
      if (r.prev_hash !== prev || r.hash !== expected) {
        return { ok: false, entries: rows.length, brokenAtSeq: Number(r.seq) };
      }
      prev = r.hash;
    }
    return { ok: true, entries: rows.length, brokenAtSeq: null };
  }

  async list(limit: number, beforeSeq?: number) {
    const { rows } = await this.db.query(
      `select a.seq, a.at, a.action, a.entity, a.entity_id, a.payload, u.username as actor
       from audit_log a left join users u on u.id = a.actor_id
       where ($2::bigint is null or a.seq < $2)
       order by a.seq desc limit $1`,
      [limit, beforeSeq ?? null],
    );
    return rows;
  }
}
