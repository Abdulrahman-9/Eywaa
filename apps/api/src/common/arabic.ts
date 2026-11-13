const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** يحوّل الأرقام الهندية (٠-٩) إلى 0-9. */
export function toAsciiDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (ch) => {
    const i = ARABIC_INDIC.indexOf(ch);
    return String(i >= 0 ? i : EASTERN_INDIC.indexOf(ch));
  });
}

/**
 * يوحّد رسم الاسم العربي للمقارنة: يحذف التشكيل والتطويل، ويوحّد
 * الألف (أ إ آ ٱ ← ا) والتاء المربوطة (ة ← ه) والألف المقصورة (ى ← ي)
 * والهمزات على الكراسي، ويضمّ «عبد» إلى ما بعدها.
 */
export function normalizeName(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
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

/** رقم وثيقة: أرقام وحروف فقط، بلا فراغات ولا فواصل. */
export function normalizeDocNumber(input: string): string {
  return toAsciiDigits(input).replace(/[\s\-_/.]/g, '').toUpperCase();
}

/** هاتف عراقي بصيغة محلية موحّدة: 07XXXXXXXXX. يعيد null إن لم يصحّ. */
export function normalizeIraqiPhone(input: string): string | null {
  let d = toAsciiDigits(input).replace(/\D/g, '');
  if (d.startsWith('00964')) d = d.slice(5);
  else if (d.startsWith('964')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^7\d{9}$/.test(d) ? `0${d}` : null;
}
