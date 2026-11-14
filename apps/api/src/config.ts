import { z } from 'zod';

const key32 = z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
  message: 'must be 32 bytes, base64-encoded',
});

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  JWT_SECRET: z.string().min(32),
  FIELD_ENC_KEY: key32,
  FIELD_HMAC_KEY: key32,
  STORAGE_DIR: z.string().default('./storage'),
  // بذرة مفتاح توقيع رموز الاستلام (Ed25519). من يملكها يصدر رموزاً صحيحة، فتُحفظ كأشد الأسرار.
  TOKEN_SIGNING_SEED: key32,
  // المنطقة التي تُحسب بها حدود اليوم والشهر (كشوف الحساب، بداية الحملة ونهايتها، «هذا الشهر»). المركز في العراق.
  // إلزام المدير والمحاسب بالتحقق بعاملين: لا يُفتح لهما شيء حتى يفعّلاه. يُضبط في النشر.
  REQUIRE_TOTP: z.enum(['0', '1', 'true', 'false', '']).default('').transform((v) => v === '1' || v === 'true'),
  // عدد الوسطاء الموثوقين أمام الخادم (Caddy واحد في النشر). به يُعرف عنوان الطالب الحق لكبح محاولات الدخول.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  // أقصى محاولات دخول خاطئة من عنوان واحد في عشر دقائق، مهما تعدّدت الأسماء.
  LOGIN_FAILS_PER_IP: z.coerce.number().int().min(5).default(40),
  APP_TIMEZONE: z.string().regex(/^[A-Za-z_]+\/[A-Za-z_]+$|^UTC$/).default('Asia/Baghdad'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
