import { Controller, Get, Inject, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/auth.guard';
import { Db } from '../db/db.module';
import { FieldCrypto } from './crypto';

@Controller()
export class HealthController implements OnModuleInit {
  constructor(@Inject(Db) private readonly db: Db, @Inject(FieldCrypto) private readonly crypto: FieldCrypto) {}

  /**
   * مفتاح غير مفتاح القاعدة لا يُقلَع به: لو أقلع لكتب بيانات لا تُفكّ مع القديمة، ولا يُكتشف ذلك إلا يوم يُحتاج إليها.
   * (يقع هذا عند استرجاع نسخة احتياطية إلى خادم جديد بملف بيئة غير ملفها.)
   */
  async onModuleInit(): Promise<void> {
    const { rows } = await this.db.query('select number_enc from person_documents limit 5');
    for (const r of rows) {
      try { this.crypto.decrypt(r.number_enc); } catch {
        throw new Error('FIELD_ENC_KEY does not decrypt the data in this database. Refusing to start: use the key the data was written with.');
      }
    }
  }

  /** للمراقبة الخارجية وفحص الحاوية: هل الخادم قائم وقاعدته تجيب. لا يكشف شيئاً غير ذلك. */
  @Public()
  @Get('health')
  async health() {
    try {
      await this.db.query('select 1');
    } catch {
      throw new ServiceUnavailableException({ ok: false, db: false });
    }
    return { ok: true, db: true };
  }
}
