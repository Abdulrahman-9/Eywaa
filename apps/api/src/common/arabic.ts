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

/**
 * الصورة الموحّدة لرقم وثيقة أو سجل، يُبنى عليها مفتاح الفرادة:
 * أرقام لاتينية، بلا فواصل ولا مسافات، وبلا أصفار في أوله («0045» و«٤٥» و«45» واحد).
 * فلا يفلت من الكشف من كُتب رقمه مرة بصفر ومرة بلا صفر.
 */
export function canonicalId(input: string): string {
  const v = normalizeDocNumber(input);
  return /^\d+$/.test(v) ? v.replace(/^0+(?=\d)/, '') : v;
}

/** المسافة بين نصّين: كم حرفاً يُبدَّل أو يُزاد أو يُنقص أو يُقلب مع جاره، حتى حدّ max. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
