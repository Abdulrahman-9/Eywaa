/* المبلغ كتابةً، كما يُكتب في السندات: «مئتان وخمسون ألف دينار عراقي لا غير». للأعداد الصحيحة حتى ما دون ألف مليار. */
const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مئة', 'مئتان', 'ثلاثمئة', 'أربعمئة', 'خمسمئة', 'ستمئة', 'سبعمئة', 'ثمانمئة', 'تسعمئة'];
/** المفرد، المثنى، الجمع (لثلاثة إلى عشرة)، المنصوب (لأحد عشر إلى تسعة وتسعين). */
const SCALES: [number, string, string, string, string][] = [
  [1_000_000_000, 'مليار', 'ملياران', 'مليارات', 'ملياراً'],
  [1_000_000, 'مليون', 'مليونان', 'ملايين', 'مليوناً'],
  [1_000, 'ألف', 'ألفان', 'آلاف', 'ألفاً'],
];

function below1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100), r = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (r) parts.push(r < 20 ? ONES[r] : r % 10 ? `${ONES[r % 10]} و${TENS[Math.floor(r / 10)]}` : TENS[Math.floor(r / 10)]);
  return parts.join(' و');
}

function scaled(n: number, [, one, two, plural, accusative]: (typeof SCALES)[number]): string {
  if (n === 1) return one;
  if (n === 2) return two;
  const tail = n % 100;
  return `${below1000(n)} ${tail >= 3 && tail <= 10 ? plural : tail >= 11 ? accusative : one}`;
}

export function numberInWords(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return 'صفر';
  const parts: string[] = [];
  for (const scale of SCALES) {
    const count = Math.floor(n / scale[0]);
    if (count) parts.push(scaled(count, scale));
    n %= scale[0];
  }
  if (n) parts.push(below1000(n));
  return parts.join(' و');
}

/** العدد ومعدوده على ما تقتضيه العربية: ثلاثة دنانير، أحد عشر ديناراً، مئتا دينار، ألف دينار. */
export function amountInWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return 'لا شيء';
  if (n === 1) return 'دينار عراقي واحد لا غير';
  if (n === 2) return 'ديناران عراقيان لا غير';
  const tail = n % 100;
  let words = numberInWords(n);
  let noun = 'دينار عراقي';
  if (tail >= 3 && tail <= 10) noun = 'دنانير عراقية';
  else if (tail >= 11) noun = 'ديناراً عراقياً';
  // العدد المضاف إلى معدوده يُحذف تنوينه ونون مثنّاه: ألفاً ← ألف، مئتان ← مئتا.
  else if (tail === 0) words = words.replace(/اً$/, '').replace(/ان$/, 'ا');
  return `${words} ${noun} لا غير`;
}
