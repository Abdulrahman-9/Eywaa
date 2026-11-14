import { createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'crypto';

/**
 * رمز الاستلام: حمولة موقَّعة بـEd25519.
 * الجهاز يتحقق من التوقيع بالمفتاح العام دون اتصال، فلا يُزوَّر الرمز ولو عُرف شكله.
 * الصيغة:  E1.<الحمولة base64url>.<التوقيع base64url>
 */
export interface TokenPayload {
  /** معرّف الاستحقاق */ e: string;
  /** معرّف الحملة */ c: string;
  /** نقطة التوزيع المعيَّنة */ p: string;
  /** رقم العائلة */ f: string;
  /** المقدار */ q: number;
  /** نهاية الصلاحية، ثوانٍ منذ 1970 */ x: number;
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class TokenSigner {
  private readonly privateKey: KeyObject;
  readonly publicKeyB64: string;

  constructor(seedB64: string) {
    const seed = Buffer.from(seedB64, 'base64');
    if (seed.length !== 32) throw new Error('TOKEN_SIGNING_SEED must be 32 bytes, base64-encoded');
    this.privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    const spki = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' });
    this.publicKeyB64 = spki.subarray(spki.length - 32).toString('base64');
  }

  issue(payload: TokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `E1.${body}.${sign(null, Buffer.from(`E1.${body}`), this.privateKey).toString('base64url')}`;
  }
}

/** يتحقق من التوقيع ويعيد الحمولة، أو null إن كان الرمز مزوَّراً أو معبوثاً به. يعمل على الجهاز دون اتصال. */
export function verifyToken(token: string, publicKeyB64: string): TokenPayload | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'E1') return null;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(`E1.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof p.e !== 'string' || typeof p.c !== 'string' || typeof p.p !== 'string' || typeof p.f !== 'string' || !Number.isInteger(p.q) || !Number.isInteger(p.x)) return null;
    return p as TokenPayload;
  } catch {
    return null;
  }
}
