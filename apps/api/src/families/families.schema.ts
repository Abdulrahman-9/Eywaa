import { z } from 'zod';
import { canonicalId, normalizeDocNumber, normalizeIraqiPhone } from '../common/arabic';

export const text = z.string().trim().min(1);
export const optionalText = z.string().trim().min(1).optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD');

export const phone = z.string().transform((v, ctx) => {
  const normalized = normalizeIraqiPhone(v);
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: 'رقم هاتف عراقي غير صالح' });
    return z.NEVER;
  }
  return normalized;
});

const docNumber = z.string().transform(normalizeDocNumber).pipe(z.string().min(1));

/**
 * وثائق الهوية العراقية:
 * - البطاقة الوطنية الموحدة: 12 خانة.
 * - هوية الأحوال المدنية القديمة: رقم + سجل + صفحة.
 * - شهادة الجنسية: رقم + رقم المحفظة.
 */
export const documentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('NATIONAL_CARD'),
    number: docNumber.pipe(z.string().regex(/^\d{12}$/, 'رقم البطاقة الوطنية 12 خانة')),
    issuedAt: date.optional(),
  }),
  z.object({
    type: z.literal('CIVIL_ID'),
    number: docNumber,
    register: docNumber,
    page: docNumber,
    issuedAt: date.optional(),
  }),
  z.object({
    type: z.literal('NATIONALITY_CERT'),
    number: docNumber,
    portfolio: docNumber,
    issuedAt: date.optional(),
  }),
]);
export type DocumentInput = z.infer<typeof documentSchema>;

/**
 * المفتاح الداخلي الذي تُفرض به فرادة الوثيقة في النظام كله. لا يخرج من الخادم؛ يُحفظ منه بصمته وحدها.
 * - البطاقة الوطنية: رقمها (12 خانة، فريد في البلد).
 * - هوية الأحوال القديمة: السجل ثم الرقم. الرقم وحده يتكرر بين السجلات، والسجل معه يفرده.
 *   الصفحة ليست من المفتاح: من كُتبت صفحته خطأً يبقى هو هو.
 * - شهادة الجنسية: الرقم والمحفظة.
 * وكل جزء بصورته الموحّدة (canonicalId)، فلا يفرّق بين الكتابتين صفرٌ في الأول ولا رقم هندي.
 */
export function documentKey(d: DocumentInput): string {
  switch (d.type) {
    case 'NATIONAL_CARD':
      return `NC:${d.number}`;
    case 'CIVIL_ID':
      return `CI2:${canonicalId(d.register)}:${canonicalId(d.number)}`;
    case 'NATIONALITY_CERT':
      return `NT2:${canonicalId(d.portfolio)}:${canonicalId(d.number)}`;
  }
}

/** مفتاح الرقم وحده، بلا سجل ولا محفظة: للمطابقة حين يختلف السجل أو يُخطأ فيه. ليس مفتاح فرادة. */
export function documentNumberKey(type: DocumentInput['type'], number: string): string {
  return `NUM:${type}:${canonicalId(number)}`;
}

export const memberSchema = z.object({
  relation: z.enum(['HEAD', 'SPOUSE', 'SON', 'DAUGHTER', 'FATHER', 'MOTHER', 'BROTHER', 'SISTER', 'OTHER']),
  fullName: text,
  motherName: optionalText,
  gender: z.enum(['M', 'F']),
  birthDate: date.optional(),
  status: z.enum(['ACTIVE', 'DECEASED']).default('ACTIVE'),
  isOrphan: z.boolean().default(false),
  disability: optionalText,
  chronicIllness: optionalText,
  documents: z.array(documentSchema).max(10).default([]),
});

export const createFamilySchema = z
  .object({
    clientOpId: z.string().uuid().optional(),
    /** الطلب السريع الذي تُستكمل به هذه الاستمارة: يُغلق بها. */
    quickRequestId: z.string().uuid().optional(),
    tags: z.array(z.enum(['ORPHANS', 'WIDOW', 'DISABLED', 'SICK', 'DIVORCED', 'NEEDY', 'UNMARRIED'])).default([]),
    phone1: phone.optional(),
    phone2: phone.optional(),
    hasWhatsapp: z.boolean().default(true),
    prefersVoice: z.boolean().default(false),
    address: z
      .object({ mahalla: optionalText, street: optionalText, house: optionalText, landmark: optionalText })
      .default({}),
    housing: z.enum(['OWNED', 'RENTED', 'OTHER']).optional(),
    housingOther: optionalText,
    prevAddress: optionalText,
    prevLandmark: optionalText,
    residenceCard: z.object({ number: docNumber, issuedAt: date.optional(), issuedBy: optionalText }).optional(),
    rationCard: z.object({ number: docNumber, issuedAt: date.optional(), center: optionalText }).optional(),
    location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
    notes: optionalText,
    // حدود عليا: أسرة من ستين فرداً لا تكون، وطلب بمئة ألف فرد يُراد به إنهاك الخادم.
    members: z.array(memberSchema).min(1).max(60),
    incomes: z
      .array(
        z.object({
          kind: z.enum(['SALARY', 'PENSION', 'SOCIAL_WELFARE', 'WORK', 'OTHER_AID']),
          amountIqd: z.number().int().min(0).max(1_000_000_000),
          note: optionalText,
        }),
      )
      .max(20)
      .default([]),
    proxies: z.array(z.object({ fullName: text, phone: phone.optional(), relation: optionalText })).max(10).default([]),
  })
  .superRefine((f, ctx) => {
    const heads = f.members.filter((m) => m.relation === 'HEAD');
    if (heads.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['members'], message: 'للعائلة رب أسرة واحد لا غير' });
    } else if (heads[0].documents.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['members'], message: 'يلزم لرب الأسرة وثيقة هوية واحدة على الأقل' });
    }
    const seen = new Map<string, number>();
    f.members.forEach((m, i) =>
      m.documents.forEach((d) => {
        const key = documentKey(d);
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['members', i, 'documents'],
            message: `الوثيقة نفسها مُدخَلة لفردين في الاستمارة (الفرد ${seen.get(key)! + 1} والفرد ${i + 1})`,
          });
        }
        seen.set(key, i);
      }),
    );
  });
export type CreateFamilyInput = z.infer<typeof createFamilySchema>;

export const decisionSchema = z.object({ note: z.string().trim().min(1).optional() });
export const resolveFlagSchema = z.object({
  decision: z.enum(['DISMISS', 'CONFIRM']),
  note: z.string().trim().min(3, 'يلزم ذكر سبب القرار'),
});
