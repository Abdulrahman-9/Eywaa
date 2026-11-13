import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

/** تشفير الحقول الحساسة وبصماتها. البصمة (HMAC) ثابتة لكل قيمة فتصلح للفرادة والبحث. */
export class FieldCrypto {
  private readonly encKey: Buffer;
  private readonly hmacKey: Buffer;

  constructor(encKeyB64: string, hmacKeyB64: string) {
    this.encKey = Buffer.from(encKeyB64, 'base64');
    this.hmacKey = Buffer.from(hmacKeyB64, 'base64');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  decrypt(token: string): string {
    const raw = Buffer.from(token, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  blindIndex(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value).digest('hex');
  }
}

/** يُظهر آخر أربع خانات فقط. */
export function mask(value: string): string {
  return value.length <= 4 ? '****' : `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}
