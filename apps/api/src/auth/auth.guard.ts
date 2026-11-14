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
  'DISTRIBUTOR', 'STOREKEEPER', 'ACCOUNTANT', 'PROJECT_SUPERVISOR', 'AUDITOR',
] as const;
export type Role = (typeof ROLES)[number];

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  role: Role;
}

const PUBLIC_KEY = 'isPublic';
const ROLES_KEY = 'roles';

/** مسار لا يحتاج دخولاً. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** الأدوار المأذون لها. كل مسار غير عامّ يجب أن يحمل هذا الوسم، وإلا رُفض. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
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

    let userId: string;
    try {
      const claims = jwt.verify(header.slice(7), this.config.JWT_SECRET, { algorithms: ['HS256'] });
      userId = (claims as jwt.JwtPayload).sub as string;
    } catch {
      throw new UnauthorizedException('جلسة غير صالحة أو منتهية');
    }

    // يُقرأ الدور من القاعدة في كل طلب، فتعطيل الحساب أو تغيير دوره يسري فوراً.
    const { rows } = await this.db.query(
      'select id, username, full_name as "fullName", role from users where id = $1 and active',
      [userId],
    );
    if (!rows[0]) throw new UnauthorizedException('الحساب معطَّل أو غير موجود');
    req.user = rows[0] as AuthUser;

    // طلبات تطبيق الميدان تحمل معرّف جهازها. الجهاز المسحوب يُرفض، والتطبيق يمحو ما عليه حين يبلغه الرفض.
    const deviceId: unknown = req.headers['x-device-id'];
    if (typeof deviceId === 'string' && /^[0-9a-f-]{36}$/i.test(deviceId)) {
      const d = await this.db.query('select revoked_at, last_seen_at from devices where id = $1', [deviceId]);
      if (d.rows[0]?.revoked_at) throw new ForbiddenException({ message: 'سُحب هذا الجهاز من النظام', code: 'DEVICE_REVOKED' });
      // «آخر ظهور» يُحدَّث كل خمس دقائق على الأكثر، فلا يكتب كل طلب في القاعدة.
      if (d.rows[0] && Date.now() - new Date(d.rows[0].last_seen_at).getTime() > 300_000) {
        await this.db.query('update devices set last_seen_at = now() where id = $1', [deviceId]);
      }
    }

    const allowed = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (!allowed || !allowed.includes(req.user.role)) {
      throw new ForbiddenException('لا صلاحية لك في هذه العملية');
    }
    return true;
  }
}
