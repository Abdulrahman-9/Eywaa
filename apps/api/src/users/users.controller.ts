import { Body, ConflictException, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
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
const updateSchema = z.object({ active: z.boolean().optional(), role: z.enum(ROLES).optional() });

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
      'select id, username, full_name as "fullName", role, active, created_at as "createdAt" from users order by created_at',
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
    return this.db.tx(async (c) => {
      const { rows } = await c.query(
        'update users set active = coalesce($2, active), role = coalesce($3, role) where id = $1 returning id, username, role, active',
        [id, body.active ?? null, body.role ?? null],
      );
      if (rows[0]) {
        await this.audit.append(c, { actorId: actor.id, action: 'user.update', entity: 'user', entityId: id, payload: body });
      }
      return rows[0] ?? null;
    });
  }
}
