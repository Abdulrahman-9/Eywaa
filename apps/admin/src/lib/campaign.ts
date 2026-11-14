import { formatDate, formatNumber } from './format';
import { TAGS } from './labels';

export const CLASS_LETTER = { A: 'أ', B: 'ب', C: 'ج', D: 'د' } as const;
export type Order = 'POINTS' | 'OLDEST' | 'NEWEST' | 'MEMBERS' | 'FAMILY_NO' | 'LEAST_BENEFITED';
export const ORDER_AR: Record<Order, string> = {
  POINTS: 'الأعلى نقاطاً أولاً', LEAST_BENEFITED: 'الأقل استفادةً أولاً', OLDEST: 'الأقدم تسجيلاً أولاً', NEWEST: 'الأحدث تسجيلاً أولاً', MEMBERS: 'الأكثر أفراداً أولاً', FAMILY_NO: 'برقم العائلة',
};
export const PICKED_AR = { RULE: 'بالقاعدة', NOMINATED: 'بالترشيح', MANUAL: 'باليد' } as const;

export interface Selection {
  classes?: string[]; minPoints?: number; maxPoints?: number; registeredFrom?: string; registeredTo?: string; membersMin?: number; membersMax?: number;
  tagsAny?: string[]; mahallas?: string[]; order?: Order; limit?: number; maxQuantity?: number; include?: string[]; nominated?: string[]; exclude?: string[]; manualOnly?: boolean;
  maxBenefits?: { count: number; months: number; scope: 'PROGRAM' | 'ALL' }; notSinceDays?: { days: number; scope: 'PROGRAM' | 'ALL' };
}

/** كيف اختيرت عوائل الحملة، بكلام يُقرأ: للمعتمِد اليوم، ولمن يرجع إليها بعد عام. */
export function describeSelection(s: Selection, unit: string): string[] {
  if (s.manualOnly) return [`اختيرت باليد: ${s.include?.length ?? 0} عائلة بأرقامها`];
  const out: string[] = [];
  if (s.classes?.length) out.push(`الفئة ${s.classes.map((c) => CLASS_LETTER[c as keyof typeof CLASS_LETTER]).join(' أو ')}`);
  if (s.minPoints !== undefined) out.push(`${s.minPoints} نقطة فأكثر`);
  if (s.membersMin !== undefined || s.membersMax !== undefined) out.push(`الأفراد ${s.membersMin ?? 1} إلى ${s.membersMax ?? 'ما فوق'}`);
  if (s.registeredFrom || s.registeredTo) out.push(`سُجّلت ${s.registeredFrom ? `من ${formatDate(s.registeredFrom)} ` : ''}${s.registeredTo ? `حتى ${formatDate(s.registeredTo)}` : ''}`.trim());
  if (s.tagsAny?.length) out.push(s.tagsAny.map((t) => TAGS[t as keyof typeof TAGS]).join(' أو '));
  if (s.mahallas?.length) out.push(`المحلة: ${s.mahallas.join('، ')}`);
  const scope = (x: 'PROGRAM' | 'ALL') => (x === 'ALL' ? 'من كل البرامج' : 'من هذا البرنامج');
  if (s.maxBenefits) out.push(s.maxBenefits.count === 0 ? `لم تستفد ${scope(s.maxBenefits.scope)} في آخر ${s.maxBenefits.months} شهراً` : `استفادت ${s.maxBenefits.count} مرة على الأكثر ${scope(s.maxBenefits.scope)} في آخر ${s.maxBenefits.months} شهراً`);
  if (s.notSinceDays) out.push(`لم تستلم ${scope(s.notSinceDays.scope)} منذ ${s.notSinceDays.days} يوماً`);
  if (!out.length) out.push('كل من يستحق البرنامج');
  if (s.limit || s.maxQuantity) out.push(`المستهدف ${[s.limit && `${formatNumber(s.limit)} عائلة`, s.maxQuantity && `${formatNumber(s.maxQuantity)} ${unit}`].filter(Boolean).join(' و')}، ${ORDER_AR[s.order ?? 'FAMILY_NO']}`);
  if (s.nominated?.length) out.push(`أُكمل العدد بالترشيح: ${s.nominated.length}`);
  if (s.include?.length) out.push(`أُضيفت باليد: ${s.include.length}`);
  if (s.exclude?.length) out.push(`استُثنيت باليد: ${s.exclude.length}`);
  return out;
}

