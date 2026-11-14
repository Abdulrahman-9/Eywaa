import { Body, ConflictException, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser, CurrentUser, ROLES, Roles } from '../auth/auth.guard';
import { hashPassword } from '../auth/password';
import { ZodPipe } from '../common/zod.pipe';
import { Db } from '../db/db.module';

const createSchema = z.object({
  username: z.string().regex(/^[a-z0-9_.]{3,32}$/, 'حروف لاتينية صغيرة وأرقام، من 3 إلى 32'),
  fullName: z.string().min(2),
  password: z.string().min(12, 'كلمة المرور 12 خانة على الأقل'),
  role: z.enum(ROLES),
});
const updateSchema = z.object({
  active: z.boolean().optional(),
  role: z.enum(ROLES).optional(),
  /** كلمة مرور مؤقتة: يُلزم صاحبها بتغييرها عند أول دخول. */
  password: z.string().min(12, 'كلمة المرور 12 خانة على الأقل').optional(),
  /** يفكّ قفل الحساب ويعطّل التحقق بعاملين (لمن فقد هاتفه). */
  resetAccess: z.literal(true).optional(),
});

@Controller('users')
@Roles('ADMIN')
export class UsersController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    const { rows } = await this.db.query(
      'select id, username, full_name as "fullName", role, active, created_at as "createdAt", totp_enabled as "totpEnabled", (locked_until is not null and locked_until > now()) as locked from users order by created_at',
    );
    return rows;
  }

  /** أسماء الموظفين الفعّالين في دور، لمن يحتاج اختيار موظف (كالمحاسب عند تسليم عهدة). */
  @Get('brief')
  @Roles('ADMIN', 'ACCOUNTANT', 'DISTRIBUTION_MANAGER', 'PROJECT_SUPERVISOR')
  async brief(@Query('role') role?: string) {
    const { rows } = await this.db.query(
      'select id, username, full_name as "fullName", role from users where active and ($1::user_role is null or role = $1) order by full_name',
      [ROLES.includes(role as never) ? role : null],
    );
    return rows;
  }

  @Post()
  async create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>, @CurrentUser() actor: AuthUser) {
    const passwordHash = await hashPassword(body.password);
    try {
      return await this.db.tx(async (c) => {
        const { rows } = await c.query(
          'insert into users (username, full_name, password_hash, role) values ($1, $2, $3, $4) returning id, username, role',
          [body.username, body.fullName, passwordHash, body.role],
        );
        await this.audit.append(c, {
          actorId: actor.id, action: 'user.create', entity: 'user', entityId: rows[0].id,
          payload: { username: body.username, role: body.role },
        });
        return rows[0];
      });
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('اسم المستخدم مستعمل');
      throw err;
    }
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
    @CurrentUser() actor: AuthUser,
  ) {
    if (id === actor.id) throw new ConflictException('لا يعدّل المدير حسابه بنفسه');
    const passwordHash = body.password ? await hashPassword(body.password) : null;
    return this.db.tx(async (c) => {
      const { rows } = await c.query(
        `update users set active = coalesce($2, active), role = coalesce($3, role),
                password_hash = coalesce($4, password_hash), must_change_password = must_change_password or $4 is not null,
                failed_logins = case when $5 then 0 else failed_logins end, locked_until = case when $5 then null else locked_until end,
                totp_enabled = case when $5 then false else totp_enabled end, totp_secret_enc = case when $5 then null else totp_secret_enc end
         where id = $1 returning id, username, role, active`,
        [id, body.active ?? null, body.role ?? null, passwordHash, !!body.resetAccess],
      );
      if (rows[0]) {
        // كلمة المرور لا تدخل سجل التدقيق؛ يُسجَّل أنها بُدّلت.
        await this.audit.append(c, { actorId: actor.id, action: 'user.update', entity: 'user', entityId: id, payload: { active: body.active, role: body.role, passwordReset: !!body.password, accessReset: !!body.resetAccess } });
      }
      return rows[0] ?? null;
    });
  }
}
