import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { Db } from '../db/db.module';

/** الإعدادات المعروفة وقواعد صحّتها. ما ليس هنا لا يُقبل. */
export const SETTINGS = {
  poverty_line_iqd: {
    label: 'خط الفقر: دخل الفرد الشهري بالدينار',
    schema: z.number().int().min(1).max(100_000_000),
  },
  bulk_message_approval_threshold: {
    label: 'عدد الرسائل الذي يحتاج ما فوقه اعتماداً',
    schema: z.number().int().min(1).max(1_000_000),
  },
} as const;
export type SettingKey = keyof typeof SETTINGS;

@Injectable()
export class SettingsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async get<T = unknown>(key: SettingKey): Promise<T> {
    const { rows } = await this.db.query('select value from settings where key = $1', [key]);
    if (!rows[0]) throw new NotFoundException(`الإعداد ${key} غير موجود`);
    return rows[0].value as T;
  }

  async list() {
    const { rows } = await this.db.query(
      `select s.key, s.value, s.updated_at, u.username as updated_by
       from settings s left join users u on u.id = s.updated_by order by s.key`,
    );
    return rows.map((r) => ({
      key: r.key, label: SETTINGS[r.key as SettingKey]?.label ?? r.key, value: r.value,
      updatedAt: r.updated_at, updatedBy: r.updated_by,
    }));
  }

  async history(key: string) {
    const { rows } = await this.db.query(
      `select h.old_value, h.new_value, h.changed_at, u.username as changed_by
       from settings_history h join users u on u.id = h.changed_by where h.key = $1 order by h.id desc`,
      [key],
    );
    return rows.map((r) => ({ oldValue: r.old_value, newValue: r.new_value, changedAt: r.changed_at, changedBy: r.changed_by }));
  }

  async set(key: string, value: unknown, actor: AuthUser) {
    const def = SETTINGS[key as SettingKey];
    if (!def) throw new NotFoundException('إعداد غير معروف');
    const parsed = def.schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException('قيمة غير صالحة لهذا الإعداد');
    await this.db.tx(async (c) => {
      const old = await c.query('select value from settings where key = $1 for update', [key]);
      const oldValue = old.rows[0]?.value ?? null;
      await c.query(
        `insert into settings (key, value, updated_by, updated_at) values ($1, $2, $3, now())
         on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [key, JSON.stringify(parsed.data), actor.id],
      );
      await c.query('insert into settings_history (key, old_value, new_value, changed_by) values ($1, $2, $3, $4)', [
        key, oldValue === null ? null : JSON.stringify(oldValue), JSON.stringify(parsed.data), actor.id,
      ]);
      await this.audit.append(c, {
        actorId: actor.id, action: 'setting.change', entity: 'setting', entityId: key,
        payload: { oldValue, newValue: parsed.data },
      });
    });
    return { key, value: parsed.data };
  }
}
