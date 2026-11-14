import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpException, Inject, Ip, Post, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { FieldCrypto } from '../common/crypto';
import { ZodPipe } from '../common/zod.pipe';
import { Config } from '../config';
import { CONFIG, Db } from '../db/db.module';
import { AnyRole, AuthUser, CurrentUser, DuringSetup, Public, SENSITIVE_ROLES } from './auth.guard';
import { hashPassword, verifyPassword } from './password';
import { newSecret, otpauthUri, verifyCode } from './totp';

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200), code: z.string().max(10).optional() });
const passwordSchema = z.object({ current: z.string().min(1).max(200), next: z.string().min(12, 'كلمة المرور 12 خانة على الأقل').max(200) });
const codeSchema = z.object({ code: z.string().min(6).max(10) });
const disableSchema = z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(10) });

/** بعد خمس محاولات خاطئة متتالية يُقفل الحساب ربع ساعة. */
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
/** نافذة كبح العنوان الواحد. */
const IP_WINDOW_MS = 10 * 60_000;
export { SENSITIVE_ROLES };

@Controller('auth')
export class AuthController {
  /** المحاولات الخاطئة لكل عنوان، في الذاكرة: الخادم عملية واحدة، وإعادة تشغيله تصفّرها ولا ضرر. */
  private readonly ipFails = new Map<string, number[]>();

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  /** قفل الحساب يحمي الاسم الواحد؛ وهذا يحمي من يجرّب كلمة واحدة على أسماء كثيرة من عنوان واحد. */
  private throttled(ip: string): boolean {
    const since = Date.now() - IP_WINDOW_MS;
    const hits = (this.ipFails.get(ip) ?? []).filter((t) => t > since);
    if (hits.length) this.ipFails.set(ip, hits); else this.ipFails.delete(ip);
    return hits.length >= this.config.LOGIN_FAILS_PER_IP;
  }

  private noteFail(ip: string): void {
    const hits = this.ipFails.get(ip) ?? [];
    hits.push(Date.now());
    this.ipFails.set(ip, hits);
    if (this.ipFails.size > 10_000) {
      const since = Date.now() - IP_WINDOW_MS;
      for (const [k, v] of this.ipFails) if (!v.some((t) => t > since)) this.ipFails.delete(k);
    }
  }

  /**
   * يحجز محاولة قبل فحص السرّ. العدّاد يزيد في القاعدة نفسها بجملة واحدة، فلا تعبر المحاولات المتزامنة الحدّ:
   * لو قُرئ العدّاد ثم كُتب «ما قُرئ + 1» لعبرت مئة محاولة معاً والعدّاد عند واحد.
   */
  private async reserveAttempt(userId: string): Promise<void> {
    const reserved = await this.db.query(
      'update users set failed_logins = failed_logins + 1 where id = $1 and (locked_until is null or locked_until <= now()) and failed_logins < $2',
      [userId, MAX_FAILED],
    );
    if (reserved.rowCount) return;
    // امتلأ الحدّ بمحاولات لم تنتهِ بعد (أو انقطعت): يُقفل الآن، فلا يبقى العدّاد عالقاً عند حدّه بلا قفل.
    await this.lockIfExhausted(userId, false);
    const { rows } = await this.db.query('select locked_until from users where id = $1', [userId]);
    const until = rows[0]?.locked_until ? new Date(rows[0].locked_until).getTime() : 0;
    const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    throw new HttpException({ message: `أُقفل الحساب لكثرة المحاولات الخاطئة. أعد المحاولة بعد ${minutes} دقيقة.`, code: 'LOCKED' }, 429);
  }

  /** إن بلغ العدّاد حدّه أُقفل الحساب وسُجّل. وإن كان الإخفاق من داخل جلسة قائمة أُنهيت الجلسات: من يخمّن فيها ليس صاحبها. */
  private async lockIfExhausted(userId: string, endSessions: boolean): Promise<void> {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query(
        `update users set locked_until = now() + make_interval(mins => $3::int), failed_logins = 0, token_version = token_version + $4::int
         where id = $1 and failed_logins >= $2 and (locked_until is null or locked_until <= now())`,
        [userId, MAX_FAILED, LOCK_MINUTES, endSessions ? 1 : 0],
      );
      if (rowCount) await this.audit.append(c, { actorId: userId, action: 'auth.locked', entity: 'user', entityId: userId });
    });
  }

  /** يردّ المحاولة المحجوزة إن لم تكن إخفاقاً (كمن أدخل كلمته صحيحة ولم يُدخل رمز التحقق بعد). */
  private async release(userId: string): Promise<void> {
    await this.db.query('update users set failed_logins = greatest(failed_logins - 1, 0) where id = $1', [userId]);
  }

  private sign(userId: string, version: number): string {
    return jwt.sign({ v: version }, this.config.JWT_SECRET, { subject: userId, algorithm: 'HS256', expiresIn: '12h' });
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Ip() ip: string, @Headers('x-device-id') deviceId?: string) {
    if (this.throttled(ip)) throw new HttpException({ message: 'محاولات خاطئة كثيرة من هذا الاتصال. أعد المحاولة بعد عشر دقائق.', code: 'THROTTLED' }, 429);
    if (deviceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
      const d = await this.db.query('select 1 from devices where id::text = $1 and revoked_at is not null', [deviceId.toLowerCase()]);
      if (d.rows[0]) throw new ForbiddenException({ message: 'سُحب هذا الجهاز من النظام', code: 'DEVICE_REVOKED' });
    }
    const { rows } = await this.db.query(
      `select id, username, full_name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, totp_last_step
       from users where username = $1 and active`,
      [body.username],
    );
    const user = rows[0];
    // المستخدم المجهول يُعامَل كمن أخطأ كلمة المرور، وبالزمن نفسه، فلا تُعرف الأسماء الصحيحة.
    if (!user) {
      await verifyPassword(body.password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
      this.noteFail(ip);
      throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    await this.reserveAttempt(user.id);

    const passwordOk = await verifyPassword(body.password, user.password_hash);
    let step: number | null = null;
    let codeOk = true;
    if (passwordOk && user.totp_enabled) {
      if (!body.code) {
        await this.release(user.id);
        throw new UnauthorizedException({ message: 'أدخل رمز التحقق من تطبيق المصادقة', code: 'TOTP_REQUIRED' });
      }
      step = verifyCode(this.crypto.decrypt(user.totp_secret_enc), body.code, Date.now(), user.totp_last_step === null ? null : Number(user.totp_last_step));
      codeOk = step !== null;
    }

    const version = passwordOk && codeOk ? await this.db.tx(async (c) => {
      // الرمز الواحد لا يُقبل مرتين ولو جاء الطلبان معاً: الشرط في جملة التحديث نفسها.
      const done = await c.query(
        `update users set failed_logins = 0, locked_until = null, totp_last_step = coalesce($2::bigint, totp_last_step)
         where id = $1 and ($2::bigint is null or totp_last_step is null or totp_last_step < $2::bigint) returning token_version`,
        [user.id, step],
      );
      if (!done.rows[0]) return null;
      await this.audit.append(c, { actorId: user.id, action: 'auth.login', entity: 'user', entityId: user.id });
      return done.rows[0].token_version as number;
    }) : null;

    if (version === null) {
      this.noteFail(ip);
      await this.lockIfExhausted(user.id, false);
      if (!passwordOk) throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غير صحيحة');
      throw new UnauthorizedException({ message: 'رمز التحقق غير صحيح أو انتهى وقته', code: 'TOTP_INVALID' });
    }
    return {
      token: this.sign(user.id, version),
      user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role, mustChangePassword: user.must_change_password, totpEnabled: user.totp_enabled },
    };
  }

  @AnyRole()
  @DuringSetup()
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const { rows } = await this.db.query('select must_change_password, totp_enabled from users where id = $1', [user.id]);
    const sensitive = SENSITIVE_ROLES.includes(user.role);
    return {
      ...user, mustChangePassword: rows[0].must_change_password, totpEnabled: rows[0].totp_enabled,
      totpRecommended: sensitive, totpRequired: sensitive && this.config.REQUIRE_TOTP,
    };
  }

  /** تغيير كلمة المرور يُنهي كل جلسة سبقته، ويعيد رمزاً جديداً لهذه الجلسة وحدها. */
  @AnyRole()
  @DuringSetup()
  @Post('password')
  @HttpCode(200)
  async changePassword(@Body(new ZodPipe(passwordSchema)) body: z.infer<typeof passwordSchema>, @CurrentUser() user: AuthUser) {
    if (body.next === body.current) throw new BadRequestException('الكلمة الجديدة هي الحالية نفسها');
    await this.reserveAttempt(user.id);
    const { rows } = await this.db.query('select password_hash from users where id = $1', [user.id]);
    if (!(await verifyPassword(body.current, rows[0].password_hash))) {
      await this.lockIfExhausted(user.id, true);
      throw new ForbiddenException('كلمة المرور الحالية غير صحيحة');
    }
    const hash = await hashPassword(body.next);
    const version = await this.db.tx(async (c) => {
      const done = await c.query(
        `update users set password_hash = $2, must_change_password = false, password_changed_at = now(), failed_logins = 0, token_version = token_version + 1
         where id = $1 returning token_version`,
        [user.id, hash],
      );
      await this.audit.append(c, { actorId: user.id, action: 'auth.password_change', entity: 'user', entityId: user.id });
      return done.rows[0].token_version as number;
    });
    return { changed: true, token: this.sign(user.id, version) };
  }

  /** يبدأ تفعيل التحقق بعاملين: يُنشئ السرّ ويعيده مرة واحدة ليُدخَل في تطبيق المصادقة. */
  @AnyRole()
  @DuringSetup()
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
  @DuringSetup()
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

  /**
   * التعطيل بالعاملين معاً: كلمة المرور ورمز من التطبيق. من جلس إلى جلسة مفتوحة وعرف الكلمة لا يكفيه ذلك.
   * ومن فقد هاتفه يراجع المدير («إعادة ضبط الدخول»).
   */
  @AnyRole()
  @Post('totp/disable')
  @HttpCode(200)
  async totpDisable(@Body(new ZodPipe(disableSchema)) body: z.infer<typeof disableSchema>, @CurrentUser() user: AuthUser) {
    const { rows } = await this.db.query('select password_hash, totp_enabled, totp_secret_enc from users where id = $1', [user.id]);
    if (!rows[0].totp_enabled) throw new BadRequestException('التحقق بعاملين غير مفعَّل');
    await this.reserveAttempt(user.id);
    const passwordOk = await verifyPassword(body.password, rows[0].password_hash);
    // يُقبل الرمز الجاري ولو دُخل به قبل لحظة: التعطيل يأتي غالباً بعد الدخول مباشرة.
    const step = passwordOk ? verifyCode(this.crypto.decrypt(rows[0].totp_secret_enc), body.code, Date.now(), null) : null;
    if (step === null) {
      await this.lockIfExhausted(user.id, true);
      throw new ForbiddenException('كلمة المرور أو رمز التحقق غير صحيح');
    }
    await this.db.tx(async (c) => {
      await c.query('update users set totp_enabled = false, totp_secret_enc = null, totp_last_step = null, failed_logins = 0 where id = $1', [user.id]);
      await this.audit.append(c, { actorId: user.id, action: 'auth.totp_disable', entity: 'user', entityId: user.id });
    });
    return { enabled: false };
  }
}
