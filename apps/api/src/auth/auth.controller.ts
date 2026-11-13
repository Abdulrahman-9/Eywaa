import { Body, Controller, Get, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { Config } from '../config';
import { CONFIG, Db } from '../db/db.module';
import { AnyRole, AuthUser, CurrentUser, Public } from './auth.guard';
import { verifyPassword } from './password';

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>) {
    const { rows } = await this.db.query(
      'select id, username, full_name, role, password_hash from users where username = $1 and active',
      [body.username],
    );
    const user = rows[0];
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    await this.db.tx((c) =>
      this.audit.append(c, { actorId: user.id, action: 'auth.login', entity: 'user', entityId: user.id }),
    );
    const token = jwt.sign({}, this.config.JWT_SECRET, {
      subject: user.id,
      algorithm: 'HS256',
      expiresIn: '12h',
    });
    return { token, user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role } };
  }

  @AnyRole()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
