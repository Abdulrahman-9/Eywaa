import { z } from 'zod';

const points = z.number().int().min(0).max(100);

/** معايير النقاط. طرق الحساب ثابتة في الشيفرة، وأرقامها بيد مدير النظام. */
export const criteriaSchema = z.object({
  income: z.object({ max: points }),
  orphans: z.object({ perUnit: points, max: points }),
  housing: z.object({ OWNED: points, RENTED: points, OTHER: points }),
  disabled: z.object({ perUnit: points, max: points }),
  femaleHead: z.object({ max: points }),
  familySize: z.object({ perUnit: points, above: z.number().int().min(0).max(20), max: points }),
  chronic: z.object({ perUnit: points, max: points }),
  noIncome: z.object({ max: points }),
});
export type Criteria = z.infer<typeof criteriaSchema>;

export const thresholdsSchema = z
  .object({ a: points, b: points, c: points })
  .refine((t) => t.a > t.b && t.b > t.c && t.c > 0, 'حدود الفئات يجب أن تتنازل: أ ثم ب ثم ج');
export type Thresholds = z.infer<typeof thresholdsSchema>;

export const CRITERIA_LABELS: Record<keyof Criteria, string> = {
  income: 'دخل الفرد الشهري', orphans: 'الأيتام', housing: 'حال السكن', disabled: 'ذوو الإعاقة',
  femaleHead: 'معيلة بلا معيل', familySize: 'حجم الأسرة', chronic: 'المرض المزمن', noIncome: 'لا راتب ولا إعانة',
};

/** أقصى ما يبلغه المجموع بهذه المعايير. */
export function maxTotal(c: Criteria): number {
  return c.income.max + c.orphans.max + Math.max(c.housing.OWNED, c.housing.RENTED, c.housing.OTHER)
    + c.disabled.max + c.femaleHead.max + c.familySize.max + c.chronic.max + c.noIncome.max;
}

/** ما يلزم من بيانات العائلة لحساب نقاطها. */
export interface Facts {
  members: number;
  monthlyIncomeIqd: number;
  orphans: number;
  disabled: number;
  chronic: number;
  housing: 'OWNED' | 'RENTED' | 'OTHER' | null;
  femaleHeadNoProvider: boolean;
}

export interface Line { key: keyof Criteria; label: string; got: number; max: number; why: string }
export interface Score { points: number; class: 'A' | 'B' | 'C' | 'D'; breakdown: Line[] }
export interface AdjustedScore extends Score { base: number; adjustment: number }

export const classOf = (points: number, t: Thresholds): Score['class'] => (points >= t.a ? 'A' : points >= t.b ? 'B' : points >= t.c ? 'C' : 'D');

/**
 * تعديل الكشف الميداني: يُضاف إلى مجموع المعادلة أو يُطرح منه، ثم تُحدَّد الفئة.
 * لا ينزل المجموع عن صفر ولا يعلو أقصى ما تبلغه المعايير.
 */
export function adjust(score: Score, delta: number, t: Thresholds, max: number): AdjustedScore {
  const points = Math.min(Math.max(score.points + delta, 0), max);
  return { ...score, base: score.points, adjustment: delta, points, class: classOf(points, t) };
}

const HOUSING_AR = { OWNED: 'ملك', RENTED: 'إيجار', OTHER: 'أخرى' } as const;

export function computeScore(f: Facts, c: Criteria, t: Thresholds, povertyLineIqd: number): Score {
  const perCapita = f.members > 0 ? f.monthlyIncomeIqd / f.members : 0;
  // كلما قلّ دخل الفرد عن خط الفقر زادت النقاط؛ ومن بلغه أو جاوزه فلا نقاط له في هذا المعيار.
  const ratio = povertyLineIqd > 0 ? Math.min(Math.max(perCapita / povertyLineIqd, 0), 1) : 1;
  const housingMax = Math.max(c.housing.OWNED, c.housing.RENTED, c.housing.OTHER);
  const extra = Math.max(f.members - c.familySize.above, 0);

  const breakdown: Line[] = [
    { key: 'income', label: CRITERIA_LABELS.income, got: f.members > 0 ? Math.round(c.income.max * (1 - ratio)) : 0, max: c.income.max, why: `${Math.round(perCapita).toLocaleString('en-US')} دينار` },
    { key: 'orphans', label: CRITERIA_LABELS.orphans, got: Math.min(f.orphans * c.orphans.perUnit, c.orphans.max), max: c.orphans.max, why: `${f.orphans}` },
    { key: 'housing', label: CRITERIA_LABELS.housing, got: f.housing ? c.housing[f.housing] : 0, max: housingMax, why: f.housing ? HOUSING_AR[f.housing] : 'لم يُحدَّد' },
    { key: 'disabled', label: CRITERIA_LABELS.disabled, got: Math.min(f.disabled * c.disabled.perUnit, c.disabled.max), max: c.disabled.max, why: `${f.disabled}` },
    { key: 'femaleHead', label: CRITERIA_LABELS.femaleHead, got: f.femaleHeadNoProvider ? c.femaleHead.max : 0, max: c.femaleHead.max, why: f.femaleHeadNoProvider ? 'نعم' : 'لا' },
    { key: 'familySize', label: CRITERIA_LABELS.familySize, got: Math.min(extra * c.familySize.perUnit, c.familySize.max), max: c.familySize.max, why: `${f.members} أفراد` },
    { key: 'chronic', label: CRITERIA_LABELS.chronic, got: Math.min(f.chronic * c.chronic.perUnit, c.chronic.max), max: c.chronic.max, why: `${f.chronic}` },
    { key: 'noIncome', label: CRITERIA_LABELS.noIncome, got: f.monthlyIncomeIqd === 0 ? c.noIncome.max : 0, max: c.noIncome.max, why: f.monthlyIncomeIqd === 0 ? 'نعم' : 'لا' },
  ];
  const total = breakdown.reduce((sum, l) => sum + l.got, 0);
  return { points: total, class: classOf(total, t), breakdown };
}
