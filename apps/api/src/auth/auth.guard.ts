import {
  CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata,
  UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { Config } from '../config';
import { CONFIG, Db } from '../db/db.module';

export const ROLES = [
  'ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'DISTRIBUTION_MANAGER',
  'DISTRIBUTOR', 'STOREKEEPER', 'ACCOUNTANT', 'PROJECT_SUPERVISOR', 'AUDITOR', 'DISTRIBUTION_AGENT',
] as const;
export type Role = (typeof ROLES)[number];

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  role: Role;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_KEY = 'isPublic';
const ROLES_KEY = 'roles';
const SETUP_KEY = 'duringSetup';

/** مسار لا يحتاج دخولاً. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** الأدوار المأذون لها. كل مسار غير عامّ يجب أن يحمل هذا الوسم، وإلا رُفض. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
/** مسار يُؤذن به لمن لم يُتمّ تهيئة حسابه بعد (كلمته مؤقتة، أو لم يفعّل التحقق بعاملين وهو مُلزَم به). */
export const DuringSetup = () => SetMetadata(SETUP_KEY, true);
/** الأدوار التي تملك المال أو الصلاحيات: يُنصح أصحابها بالتحقق بعاملين، ويُلزمون به إن ضُبط REQUIRE_TOTP. */
export const SENSITIVE_ROLES: readonly string[] = ['ADMIN', 'ACCOUNTANT'];
/** كل من سجّل دخوله. */
export const AnyRole = () => SetMetadata(ROLES_KEY, [...ROLES]);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Db) private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('يلزم تسجيل الدخول');

    let userId: string, version: number;
    try {
      const claims = jwt.verify(header.slice(7), this.config.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      userId = claims.sub as string;
      version = typeof claims.v === 'number' ? claims.v : 0;
    } catch {
      throw new UnauthorizedException('جلسة غير صالحة أو منتهية');
    }

    // طلبات تطبيق الميدان تحمل معرّف جهازها. الجهاز المسحوب يُرفض، والتطبيق يمحو ما عليه حين يبلغه الرفض.
    // يُفحص قبل الجلسة: سحب الجهاز يُنهي جلسات صاحبه، والجهاز نفسه يجب أن يبلغه «سُحبت» لا «انتهت جلستك».
    const deviceId: unknown = req.headers['x-device-id'];
    const device = typeof deviceId === 'string' && UUID.test(deviceId)
      ? (await this.db.query('select revoked_at, last_seen_at from devices where id = $1', [deviceId])).rows[0]
      : undefined;
    if (device?.revoked_at) throw new ForbiddenException({ message: 'سُحب هذا الجهاز من النظام', code: 'DEVICE_REVOKED' });

    // يُقرأ الدور من القاعدة في كل طلب، فتعطيل الحساب أو تغيير دوره يسري فوراً.
    const { rows } = await this.db.query(
      'select id, username, full_name as "fullName", role, token_version, must_change_password, totp_enabled from users where id = $1 and active',
      [userId],
    );
    if (!rows[0]) throw new UnauthorizedException('الحساب معطَّل أو غير موجود');
    // رمز صدر قبل تغيير كلمة المرور أو سحب الجهاز لا يُعمل به.
    if (rows[0].token_version !== version) throw new UnauthorizedException('انتهت هذه الجلسة. ادخل من جديد.');
    const { token_version: _v, must_change_password: mustChange, totp_enabled: totpEnabled, ...user } = rows[0];
    req.user = user as AuthUser;
    // «آخر ظهور» يُحدَّث كل خمس دقائق على الأكثر، فلا يكتب كل طلب في القاعدة.
    if (device && Date.now() - new Date(device.last_seen_at).getTime() > 300_000) {
      await this.db.query('update devices set last_seen_at = now() where id = $1', [deviceId]);
    }

    // الحساب الذي لم تتمّ تهيئته لا يُفتح له إلا ما يُتمّها: الكلمة المؤقتة يعرفها من وضعها.
    if (!this.reflector.getAllAndOverride<boolean>(SETUP_KEY, targets)) {
      if (mustChange) throw new ForbiddenException({ message: 'كلمة مرورك مؤقتة. غيّرها أولاً من لوحة الإدارة.', code: 'PASSWORD_CHANGE_REQUIRED' });
      if (this.config.REQUIRE_TOTP && !totpEnabled && SENSITIVE_ROLES.includes(req.user.role)) {
        throw new ForbiddenException({ message: 'دورك يُلزَم بالتحقق بعاملين. فعّله أولاً من لوحة الإدارة.', code: 'TOTP_SETUP_REQUIRED' });
      }
    }

    const allowed = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (!allowed || !allowed.includes(req.user.role)) {
      throw new ForbiddenException('لا صلاحية لك في هذه العملية');
    }
    return true;
  }
}
