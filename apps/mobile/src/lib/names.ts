/** توحيد كتابة الاسم العربي للمقارنة. هو نفسه ما في الخادم (apps/api/src/common/arabic.ts). */
export function normalizeName(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^ء-ي\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^| )عبد /g, '$1عبد');
}
