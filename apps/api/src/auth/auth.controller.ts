import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpException, Inject, Post, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { FieldCrypto } from '../common/crypto';
import { ZodPipe } from '../common/zod.pipe';
import { Config } from '../config';
import { CONFIG, Db } from '../db/db.module';
import { AnyRole, AuthUser, CurrentUser, Public } from './auth.guard';
import { hashPassword, verifyPassword } from './password';
import { newSecret, otpauthUri, verifyCode } from './totp';

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1), code: z.string().optional() });
const passwordSchema = z.object({ current: z.string().min(1), next: z.string().min(12, 'كلمة المرور 12 خانة على الأقل').max(200) });
const codeSchema = z.object({ code: z.string().min(6).max(10) });

/** بعد خمس محاولات خاطئة متتالية يُقفل الحساب ربع ساعة. */
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
/** الأدوار التي يُلزم أصحابها بالتحقق بعاملين متى فعّلوه؛ ولغيرهم اختياري. */
export const SENSITIVE_ROLES = ['ADMIN', 'ACCOUNTANT'];

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Headers('x-device-id') deviceId?: string) {
    if (deviceId && /^[0-9a-f-]{36}$/i.test(deviceId)) {
      const d = await this.db.query('select 1 from devices where id = $1 and revoked_at is not null', [deviceId]);
      if (d.rows[0]) throw new ForbiddenException({ message: 'سُحب هذا الجهاز من النظام', code: 'DEVICE_REVOKED' });
    }
    const { rows } = await this.db.query(
      `select id, username, full_name, role, password_hash, failed_logins, locked_until, must_change_password,
              totp_enabled, totp_secret_enc, totp_last_step
       from users where username = $1 and active`,
      [body.username],
    );
    const user = rows[0];
    // المستخدم المجهول يُعامَل كمن أخطأ كلمة المرور، وبالزمن نفسه، فلا تُعرف الأسماء الصحيحة.
    if (!user) {
      await verifyPassword(body.password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
      throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutes = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
      throw new HttpException({ message: `أُقفل الحساب لكثرة المحاولات الخاطئة. أعد المحاولة بعد ${minutes} دقيقة.`, code: 'LOCKED' }, 429);
    }

    const passwordOk = await verifyPassword(body.password, user.password_hash);
    let step: number | null = null;
    let codeOk = true;
    if (passwordOk && user.totp_enabled) {
      if (!body.code) throw new UnauthorizedException({ message: 'أدخل رمز التحقق من تطبيق المصادقة', code: 'TOTP_REQUIRED' });
      step = verifyCode(this.crypto.decrypt(user.totp_secret_enc), body.code, Date.now(), user.totp_last_step === null ? null : Number(user.totp_last_step));
      codeOk = step !== null;
    }

    if (!passwordOk || !codeOk) {
      const failed = user.failed_logins + 1;
      const lock = failed >= MAX_FAILED;
      await this.db.tx(async (c) => {
        await c.query('update users set failed_logins = $2, locked_until = $3 where id = $1', [user.id, lock ? 0 : failed, lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : null]);
        if (lock) await this.audit.append(c, { actorId: user.id, action: 'auth.locked', entity: 'user', entityId: user.id });
      });
      if (!passwordOk) throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غير صحيحة');
      throw new UnauthorizedException({ message: 'رمز التحقق غير صحيح أو انتهى وقته', code: 'TOTP_INVALID' });
    }

    await this.db.tx(async (c) => {
      await c.query('update users set failed_logins = 0, locked_until = null, totp_last_step = coalesce($2, totp_last_step) where id = $1', [user.id, step]);
      await this.audit.append(c, { actorId: user.id, action: 'auth.login', entity: 'user', entityId: user.id });
    });
    const token = jwt.sign({}, this.config.JWT_SECRET, { subject: user.id, algorithm: 'HS256', expiresIn: '12h' });
    return {
      token,
      user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role, mustChangePassword: user.must_change_password, totpEnabled: user.totp_enabled },
    };
  }

  @AnyRole()
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const { rows } = await this.db.query('select must_change_password, totp_enabled from users where id = $1', [user.id]);
    return { ...user, mustChangePassword: rows[0].must_change_password, totpEnabled: rows[0].totp_enabled, totpRecommended: SENSITIVE_ROLES.includes(user.role) };
  }

  @AnyRole()
  @Post('password')
  @HttpCode(200)
  async changePassword(@Body(new ZodPipe(passwordSchema)) body: z.infer<typeof passwordSchema>, @CurrentUser() user: AuthUser) {
    const { rows } = await this.db.query('select password_hash from users where id = $1', [user.id]);
    if (!(await verifyPassword(body.current, rows[0].password_hash))) throw new ForbiddenException('كلمة المرور الحالية غير صحيحة');
    if (body.next === body.current) throw new BadRequestException('الكلمة الجديدة هي الحالية نفسها');
    const hash = await hashPassword(body.next);
    await this.db.tx(async (c) => {
      await c.query('update users set password_hash = $2, must_change_password = false, password_changed_at = now() where id = $1', [user.id, hash]);
      await this.audit.append(c, { actorId: user.id, action: 'auth.password_change', entity: 'user', entityId: user.id });
    });
    return { changed: true };
  }

  /** يبدأ تفعيل التحقق بعاملين: يُنشئ السرّ ويعيده مرة واحدة ليُدخَل في تطبيق المصادقة. */
  @AnyRole()
  @Post('totp/setup')
  @HttpCode(200)
  async totpSetup(@CurrentUser() user: AuthUser) {
    const { rows } = await this.db.query('select totp_enabled from users where id = $1', [user.id]);
    if (rows[0].totp_enabled) throw new BadRequestException('التحقق بعاملين مفعَّل. عطّله أولاً إن أردت تبديل الجهاز.');
    const secret = newSecret();
    await this.db.query('update users set totp_secret_enc = $2 where id = $1', [user.id, this.crypto.encrypt(secret)]);
    return { secret, uri: otpauthUri(secret, user.username) };
  }

  /** لا يُفعَّل حتى يثبت صاحبه برمز صحيح أن تطبيقه يعمل. */
  @AnyRole()
  @Post('totp/enable')
  @HttpCode(200)
  async totpEnable(@Body(new ZodPipe(codeSchema)) body: z.infer<typeof codeSchema>, @CurrentUser() user: AuthUser) {
    const { rows } = await this.db.query('select totp_secret_enc, totp_enabled from users where id = $1', [user.id]);
    if (rows[0].totp_enabled) throw new BadRequestException('التحقق بعاملين مفعَّل من قبل');
    if (!rows[0].totp_secret_enc) throw new BadRequestException('ابدأ التفعيل أولاً');
    const step = verifyCode(this.crypto.decrypt(rows[0].totp_secret_enc), body.code, Date.now(), null);
    if (step === null) throw new ForbiddenException('رمز التحقق غير صحيح أو انتهى وقته');
    await this.db.tx(async (c) => {
      await c.query('update users set totp_enabled = true, totp_last_step = $2 where id = $1', [user.id, step]);
      await this.audit.append(c, { actorId: user.id, action: 'auth.totp_enable', entity: 'user', entityId: user.id });
    });
    return { enabled: true };
  }

  @AnyRole()
  @Post('totp/disable')
  @HttpCode(200)
  async totpDisable(@Body(new ZodPipe(z.object({ password: z.string().min(1) }))) body: { password: string }, @CurrentUser() user: AuthUser) {
    const { rows } = await this.db.query('select password_hash from users where id = $1', [user.id]);
    if (!(await verifyPassword(body.password, rows[0].password_hash))) throw new ForbiddenException('كلمة المرور غير صحيحة');
    await this.db.tx(async (c) => {
      await c.query('update users set totp_enabled = false, totp_secret_enc = null, totp_last_step = null where id = $1', [user.id]);
      await this.audit.append(c, { actorId: user.id, action: 'auth.totp_disable', entity: 'user', entityId: user.id });
    });
    return { enabled: false };
  }
}
