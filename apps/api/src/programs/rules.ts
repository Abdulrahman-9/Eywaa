import { z } from 'zod';

const TAGS = ['ORPHANS', 'WIDOW', 'DISABLED', 'SICK', 'DIVORCED', 'NEEDY', 'UNMARRIED'] as const;

/** شروط الاستحقاق. كلها اختيارية، وتستحق العائلة إذا اجتمع فيها ما حُدِّد منها. */
export const rulesSchema = z.object({
  classes: z.array(z.enum(['A', 'B', 'C', 'D'])).min(1).optional(),
  belowPovertyLine: z.literal(true).optional(),
  tagsAny: z.array(z.enum(TAGS)).min(1).optional(),
  housingIn: z.array(z.enum(['OWNED', 'RENTED', 'OTHER'])).min(1).optional(),
  minMembers: z.number().int().min(1).max(50).optional(),
  hasOrphans: z.literal(true).optional(),
  hasDisabled: z.literal(true).optional(),
}).strict();
export type Rules = z.infer<typeof rulesSchema>;

const qty = z.number().int().min(1).max(1_000_000_000);
/** مقدار ما تستحقه العائلة. */
export const amountSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('FIXED'), value: qty }),
  z.object({ type: z.literal('PER_MEMBER'), value: qty, max: qty.optional() }),
  z.object({ type: z.literal('PER_ORPHAN'), value: qty, max: qty.optional() }),
  z.object({
    type: z.literal('BY_SIZE'),
    // شرائح بحسب عدد الأفراد، تصاعدية؛ الأخيرة بلا حدّ أعلى.
    tiers: z.array(z.object({ upTo: z.number().int().min(1).nullable(), value: qty })).min(1).max(10),
  }).refine((a) => a.tiers[a.tiers.length - 1].upTo === null && a.tiers.slice(0, -1).every((t, i, arr) => t.upTo !== null && (i === 0 || t.upTo > arr[i - 1].upTo!)),
    'الشرائح تصاعدية، والأخيرة بلا حدّ أعلى'),
]);
export type Amount = z.infer<typeof amountSchema>;

export interface FamilyFacts {
  class: 'A' | 'B' | 'C' | 'D' | null;
  members: number;
  orphans: number;
  disabled: number;
  monthlyIncomeIqd: number;
  housing: 'OWNED' | 'RENTED' | 'OTHER' | null;
  tags: string[];
}

const CLASS_AR = { A: 'أ', B: 'ب', C: 'ج', D: 'د' } as const;

/** يعيد أسباب عدم الاستحقاق؛ فإن خلت القائمة فالعائلة مستحقة. */
export function failures(r: Rules, f: FamilyFacts, povertyLineIqd: number): string[] {
  const out: string[] = [];
  if (r.classes && (!f.class || !r.classes.includes(f.class))) {
    out.push(`الفئة ${f.class ? CLASS_AR[f.class] : 'غير محسوبة'}، والمطلوب ${r.classes.map((c) => CLASS_AR[c]).join(' أو ')}`);
  }
  if (r.belowPovertyLine && !(f.members > 0 && f.monthlyIncomeIqd / f.members < povertyLineIqd)) out.push('دخل الفرد ليس دون خط الفقر');
  if (r.tagsAny && !r.tagsAny.some((t) => f.tags.includes(t))) out.push('ليست من الفئات المشمولة');
  if (r.housingIn && (!f.housing || !r.housingIn.includes(f.housing))) out.push('نوع السكن غير مشمول');
  if (r.minMembers && f.members < r.minMembers) out.push(`عدد الأفراد دون ${r.minMembers}`);
  if (r.hasOrphans && f.orphans === 0) out.push('لا يتيم فيها');
  if (r.hasDisabled && f.disabled === 0) out.push('لا معاق فيها');
  return out;
}

export function quantity(a: Amount, f: FamilyFacts): number {
  switch (a.type) {
    case 'FIXED':
      return a.value;
    case 'PER_MEMBER':
      return Math.min(f.members * a.value, a.max ?? Infinity);
    case 'PER_ORPHAN':
      return Math.min(f.orphans * a.value, a.max ?? Infinity);
    case 'BY_SIZE':
      return (a.tiers.find((t) => t.upTo === null || f.members <= t.upTo) ?? a.tiers[a.tiers.length - 1]).value;
  }
}
