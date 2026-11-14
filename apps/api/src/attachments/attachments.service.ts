import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { FieldCrypto } from '../common/crypto';
import { Db } from '../db/db.module';
import { sniffMime } from './file-type';
import { Storage } from './storage';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CATEGORIES = ['PHOTO', 'IDENTITY', 'RATION_CARD', 'RESIDENCE_CARD', 'MEDICAL', 'PAPER_FORM', 'OTHER', 'DELIVERY_PROOF'] as const;
export type Category = (typeof CATEGORIES)[number];
/** عمر رابط التنزيل. */
const LINK_TTL_SECONDS = 300;

@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Storage) private readonly storage: Storage,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async upload(
    familyId: string,
    file: { buffer: Buffer; originalname: string } | undefined,
    category: Category,
    personId: string | undefined,
    actor: AuthUser,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('لم يُرفق ملف');
    if (file.buffer.length > MAX_FILE_BYTES) throw new BadRequestException('حجم الملف يتجاوز 10 ميغابايت');
    const mime = sniffMime(file.buffer);
    if (!mime) throw new BadRequestException('نوع الملف غير مقبول: المقبول صور JPEG و PNG و WebP و HEIC وملفات PDF');

    const fam = await this.db.query('select status from families where id = $1', [familyId]);
    if (!fam.rows[0]) throw new NotFoundException('العائلة غير موجودة');
    if (personId) {
      const p = await this.db.query('select 1 from persons where id = $1 and family_id = $2', [personId, familyId]);
      if (!p.rowCount) throw new BadRequestException('الفرد ليس من هذه العائلة');
    }

    const id = randomUUID();
    const storageKey = `${familyId}/${id}`;
    // الاسم كما ورد يُحفظ للعرض فقط، ولا يدخل في مسار التخزين.
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[\\/\0]/g, '_').slice(0, 200);
    await this.storage.put(storageKey, file.buffer);
    try {
      await this.db.tx(async (c) => {
        await c.query(
          `insert into attachments (id, family_id, person_id, category, original_name, mime, size_bytes, sha256, storage_key, uploaded_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, familyId, personId ?? null, category, name, mime, file.buffer.length,
           createHash('sha256').update(file.buffer).digest('hex'), storageKey, actor.id],
        );
        await this.audit.append(c, {
          actorId: actor.id, action: 'attachment.upload', entity: 'attachment', entityId: id,
          payload: { familyId, category, mime, sizeBytes: file.buffer.length },
        });
      });
    } catch (err) {
      await this.storage.remove(storageKey);
      throw err;
    }
    return { id, category, mime, sizeBytes: file.buffer.length, originalName: name, personId: personId ?? null };
  }

  async list(familyId: string) {
    const { rows } = await this.db.query(
      `select a.id, a.person_id, a.category, a.original_name, a.mime, a.size_bytes, a.created_at, u.username
       from attachments a join users u on u.id = a.uploaded_by
       where a.family_id = $1 and a.deleted_at is null order by a.created_at`,
      [familyId],
    );
    return rows.map((r) => ({
      id: r.id, personId: r.person_id, category: r.category, originalName: r.original_name, mime: r.mime,
      sizeBytes: r.size_bytes, uploadedBy: r.username, createdAt: r.created_at,
    }));
  }

  /** يصدر رابطاً مؤقتاً، ويسجّل من طلب الاطلاع على المستند. */
  async issueLink(id: string, actor: AuthUser) {
    const { rows } = await this.db.query('select family_id from attachments where id = $1 and deleted_at is null', [id]);
    if (!rows[0]) throw new NotFoundException('المرفق غير موجود');
    const expires = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    await this.db.tx((c) =>
      this.audit.append(c, {
        actorId: actor.id, action: 'attachment.view', entity: 'attachment', entityId: id,
        payload: { familyId: rows[0].family_id },
      }),
    );
    const body = `${id}.${expires}`;
    return { url: `/api/files/${body}.${this.crypto.sign(body)}`, expiresAt: new Date(expires * 1000).toISOString() };
  }

  async readByToken(token: string) {
    const [id, exp, sig] = token.split('.');
    const expected = Buffer.from(this.crypto.sign(`${id}.${exp}`));
    const given = Buffer.from(sig ?? '');
    if (!id || !exp || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new ForbiddenException('رابط غير صالح');
    }
    if (Number(exp) < Date.now() / 1000) throw new ForbiddenException('انتهت صلاحية الرابط');
    const { rows } = await this.db.query(
      'select storage_key, mime, original_name from attachments where id = $1 and deleted_at is null',
      [id],
    );
    if (!rows[0]) throw new NotFoundException('المرفق غير موجود');
    return { data: await this.storage.get(rows[0].storage_key), mime: rows[0].mime as string, name: rows[0].original_name as string };
  }

  /** الحذف يحجب المرفق ويُبقي أثره في السجل. */
  async remove(id: string, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const { rows } = await c.query(
        'update attachments set deleted_at = now(), deleted_by = $2 where id = $1 and deleted_at is null returning family_id',
        [id, actor.id],
      );
      if (!rows[0]) throw new NotFoundException('المرفق غير موجود');
      await this.audit.append(c, {
        actorId: actor.id, action: 'attachment.delete', entity: 'attachment', entityId: id,
        payload: { familyId: rows[0].family_id },
      });
    });
    return { deleted: true };
  }
}
