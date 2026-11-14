import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** رموز التحقق الزمنية (RFC 6238): ستة أرقام تتبدل كل 30 ثانية، كما في تطبيقات المصادقة. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of text.toUpperCase().replace(/[=\s]/g, '')) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20));
export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * يتحقق من الرمز في الخطوة الحالية والتي قبلها وبعدها (لفرق الساعات)،
 * ويعيد الخطوة التي طابقها، أو null. الخطوة تُحفظ فلا يُقبل الرمز نفسه مرتين.
 */
export function verifyCode(secret: string, code: string, nowMs: number, lastStep: number | null): number | null {
  const clean = code.replace(/\D/g, '');
  if (clean.length !== 6) return null;
  const now = stepAt(nowMs);
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(codeAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(clean))) return step;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string, issuer = 'Eywaa') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
