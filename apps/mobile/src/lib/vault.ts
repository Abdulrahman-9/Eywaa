import { kv } from './db';

/**
 * خزنة الجهاز: كل ما يُحفظ محلياً يُشفَّر بـAES-256-GCM بمفتاح مشتقّ من رمز القفل (PBKDF2).
 * المفتاح لا يُحفظ؛ يُشتقّ عند كل فتح ويبقى في الذاكرة حتى يُقفل التطبيق.
 * فالهاتف إن ضاع وهو مقفل لم تُقرأ بياناته إلا بتخمين الرمز، والاشتقاق بطيء عمداً.
 */
const ROUNDS = 250_000;
const PROBE = 'eywaa-vault-v1';
const text = new TextEncoder();
const untext = new TextDecoder();

export interface Meta { salt: Uint8Array; probe: Uint8Array; deviceId: string; username: string; fullName: string; failures: number; lockedUntil: number }

let key: CryptoKey | null = null;

async function derive(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', text.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: ROUNDS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(k: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, data as BufferSource));
  const out = new Uint8Array(12 + body.length);
  out.set(iv);
  out.set(body, 12);
  return out;
}

async function unseal(k: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) as BufferSource }, k, blob.slice(12) as BufferSource));
}

export const vault = {
  meta: () => kv.get<Meta>('meta'),
  isOpen: () => key !== null,
  lock: () => { key = null; },

  /** أول تهيئة للجهاز بعد الدخول: يُنشأ الملح ومعرّف الجهاز ويُفتح القفل. */
  async create(pin: string, who: { username: string; fullName: string }): Promise<Meta> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const k = await derive(pin, salt);
    const meta: Meta = { salt, probe: await seal(k, text.encode(PROBE)), deviceId: crypto.randomUUID(), ...who, failures: 0, lockedUntil: 0 };
    await kv.clear();
    await kv.set('meta', meta);
    key = k;
    return meta;
  },

  /** يفتح بالرمز. الخطأ المتكرر يؤخّر المحاولة التالية: 30 ثانية ثم ضعفها، حتى ساعة. */
  async unlock(pin: string): Promise<{ ok: true } | { ok: false; waitMs: number }> {
    const meta = await kv.get<Meta>('meta');
    if (!meta) throw new Error('no vault');
    const wait = meta.lockedUntil - Date.now();
    if (wait > 0) return { ok: false, waitMs: wait };
    const k = await derive(pin, meta.salt);
    try {
      if (untext.decode(await unseal(k, meta.probe)) !== PROBE) throw new Error('probe');
    } catch {
      const failures = meta.failures + 1;
      const penalty = failures >= 3 ? Math.min(30_000 * 2 ** (failures - 3), 3_600_000) : 0;
      await kv.set('meta', { ...meta, failures, lockedUntil: penalty ? Date.now() + penalty : 0 });
      return { ok: false, waitMs: penalty };
    }
    if (meta.failures) await kv.set('meta', { ...meta, failures: 0, lockedUntil: 0 });
    key = k;
    return { ok: true };
  },

  async put(name: string, value: unknown): Promise<void> {
    if (!key) throw new Error('vault locked');
    await kv.set(`v:${name}`, await seal(key, text.encode(JSON.stringify(value))));
  },
  async get<T>(name: string): Promise<T | undefined> {
    if (!key) throw new Error('vault locked');
    const blob = await kv.get<Uint8Array>(`v:${name}`);
    return blob ? (JSON.parse(untext.decode(await unseal(key, blob))) as T) : undefined;
  },
  async putBytes(name: string, bytes: Uint8Array): Promise<void> {
    if (!key) throw new Error('vault locked');
    await kv.set(`b:${name}`, await seal(key, bytes));
  },
  async getBytes(name: string): Promise<Uint8Array | undefined> {
    if (!key) throw new Error('vault locked');
    const blob = await kv.get<Uint8Array>(`b:${name}`);
    return blob ? unseal(key, blob) : undefined;
  },
  delBytes: (name: string) => kv.del(`b:${name}`),

  /** يمحو كل ما على الجهاز. لا رجعة فيه. */
  async wipe(): Promise<void> {
    key = null;
    await kv.clear();
  },
};
