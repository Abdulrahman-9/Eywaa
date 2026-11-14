import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AnyRole, AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { Db } from '../db/db.module';

const registerSchema = z.object({ deviceId: z.string().uuid(), label: z.string().trim().min(1).max(120) });
const revokeSchema = z.object({ note: z.string().trim().min(3, 'يلزم ذكر السبب') });

/**
 * سجل أجهزة الميدان. الجهاز المسحوب يُرفض كل طلب منه (انظر AuthGuard)،
 * والتطبيق إن بلغه هذا الرفض محا ما عليه. حدّه: الهاتف الذي لا يتصل لا يبلغه السحب؛
 * وما عليه مشفّر برمز القفل، وجلسته تنتهي بعد 12 ساعة.
 */
@Controller()
export class DevicesController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(AuditService) private readonly audit: AuditService) {}

  @Post('devices')
  @HttpCode(200)
  @AnyRole()
  async register(@Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>, @CurrentUser() user: AuthUser) {
    const { rows } = await this.db.query('select user_id, revoked_at from devices where id = $1', [body.deviceId]);
    if (rows[0]?.revoked_at) throw new ForbiddenException({ message: 'سُحب هذا الجهاز من النظام', code: 'DEVICE_REVOKED' });
    if (rows[0]) {
      // الجهاز نفسه دخل به موظف آخر (بعد محوه وتهيئته من جديد يأخذ معرّفاً جديداً؛ فهذه حال نادرة تُسجَّل).
      if (rows[0].user_id !== user.id) {
        await this.db.tx(async (c) => {
          await c.query('update devices set user_id = $2, label = $3, last_seen_at = now() where id = $1', [body.deviceId, user.id, body.label]);
          await this.audit.append(c, { actorId: user.id, action: 'device.reassign', entity: 'device', entityId: body.deviceId, payload: { from: rows[0].user_id } });
        });
      }
      return { registered: true };
    }
    await this.db.tx(async (c) => {
      await c.query('insert into devices (id, user_id, label) values ($1,$2,$3)', [body.deviceId, user.id, body.label]);
      await this.audit.append(c, { actorId: user.id, action: 'device.register', entity: 'device', entityId: body.deviceId, payload: { label: body.label } });
    });
    return { registered: true };
  }

  @Get('devices')
  @Roles('ADMIN', 'AUDITOR')
  async list() {
    const { rows } = await this.db.query(
      `select d.id, d.label, d.registered_at, d.last_seen_at, d.revoked_at, d.revoke_note, u.username, u.full_name, u.role, r.username as revoked_by
       from devices d join users u on u.id = d.user_id left join users r on r.id = d.revoked_by order by d.revoked_at nulls first, d.last_seen_at desc limit 500`);
    return rows.map((d) => ({
      id: d.id, label: d.label, registeredAt: d.registered_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at, revokeNote: d.revoke_note,
      revokedBy: d.revoked_by, username: d.username, fullName: d.full_name, role: d.role,
    }));
  }

  @Post('devices/:id/revoke')
  @HttpCode(200)
  @Roles('ADMIN')
  async revoke(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(revokeSchema)) body: z.infer<typeof revokeSchema>, @CurrentUser() user: AuthUser) {
    await this.db.tx(async (c) => {
      const { rows } = await c.query('update devices set revoked_at = now(), revoked_by = $2, revoke_note = $3 where id = $1 and revoked_at is null returning user_id', [id, user.id, body.note]);
      if (!rows[0]) throw new NotFoundException('الجهاز غير موجود أو سُحب من قبل');
      // رمز الدخول المحفوظ على الجهاز يُبطَل معه: من أخذ الهاتف مفتوحاً لا ينفعه أن يحذف معرّف الجهاز من طلباته.
      await c.query('update users set token_version = token_version + 1 where id = $1', [rows[0].user_id]);
      await this.audit.append(c, { actorId: user.id, action: 'device.revoke', entity: 'device', entityId: id, payload: { note: body.note } });
    });
    return { revoked: true };
  }
}
