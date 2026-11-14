/**
 * تحويل ورقة Excel إلى استمارات تسجيل.
 * كل سطر فرد، والأسطر التي تشترك في «رقم الاستمارة» عائلة واحدة.
 * بيانات العائلة (الهاتف، العنوان، الدخل…) تُؤخذ من سطر رب الأسرة.
 * المنطق هنا خالص: لا شبكة فيه ولا ملفات، ليُختبر وحده.
 */

export type Cell = string | number | boolean | Date | null | undefined;

export const COLUMNS = [
  ['form', 'رقم الاستمارة'], ['relation', 'الصلة'], ['fullName', 'الاسم الكامل'], ['motherName', 'اسم الأم'],
  ['gender', 'الجنس'], ['birthDate', 'تاريخ الميلاد'], ['deceased', 'متوفى'], ['orphan', 'يتيم'],
  ['disability', 'الإعاقة'], ['illness', 'المرض المزمن'],
  ['docType', 'نوع الوثيقة'], ['docNumber', 'رقم الوثيقة'], ['docRegister', 'السجل'], ['docPage', 'الصفحة'], ['docPortfolio', 'المحفظة'],
  ['phone1', 'الهاتف'], ['phone2', 'هاتف ثان'], ['whatsapp', 'واتساب'], ['cannotRead', 'لا يقرأ'],
  ['mahalla', 'المحلة'], ['street', 'الزقاق'], ['house', 'الدار'], ['landmark', 'أقرب نقطة دالة'],
  ['housing', 'السكن'], ['ration', 'رقم البطاقة التموينية'], ['tags', 'الفئات'],
  ['salary', 'راتب'], ['pension', 'راتب تقاعدي'], ['welfare', 'رعاية اجتماعية'], ['work', 'عمل حر'], ['otherAid', 'إعانة أخرى'],
  ['notes', 'ملاحظات'],
] as const;
export type ColumnKey = (typeof COLUMNS)[number][0];

const REQUIRED: ColumnKey[] = ['form', 'relation', 'fullName'];

/** يوحّد الحروف التي تُكتب بأكثر من صورة، ليطابق «الإعاقه» «الإعاقة». */
export const fold = (v: string) =>
  v.replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, ' ').trim().toLowerCase();

const DIGITS = '٠١٢٣٤٥٦٧٨٩';
const latinDigits = (v: string) => v.replace(/[٠-٩]/g, (d) => String(DIGITS.indexOf(d)));

function str(v: Cell): string | undefined {
  if (v === null || v === undefined || v instanceof Date) return undefined;
  const s = (typeof v === 'number' ? String(v) : String(v)).trim();
  return s === '' ? undefined : s;
}

function yes(v: Cell): boolean {
  if (v === true || v === 1) return true;
  const s = str(v);
  return !!s && ['نعم', 'اي', '1', 'true', 'x', '✓', 'صح', 'yes'].includes(fold(s));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** يقبل خلية تاريخ، أو 1990-05-12، أو 12/5/1990 (اليوم أولاً كما يُكتب في العراق). */
export function toDate(v: Cell): string | undefined | null {
  if (v === null || v === undefined || v === '') return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  const s = latinDigits(String(v).trim());
  if (s === '') return undefined;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if (/^\d{4}$/.test(s)) [y, mo, d] = [Number(s), 1, 1];
  else return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** Excel يُسقط الصفر الأول من رقم الهاتف إن خُزّن عدداً. */
function toPhone(v: Cell): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const digits = latinDigits(s).replace(/[^\d+]/g, '');
  return /^7\d{9}$/.test(digits) ? `0${digits}` : digits;
}

function toAmount(v: Cell): number | null {
  const s = str(v);
  if (!s) return 0;
  const n = Number(latinDigits(s).replace(/[,،\s]/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const RELATION_WORDS: [string, string][] = [
  ['رب الاسره', 'HEAD'], ['رب اسره', 'HEAD'], ['ربه الاسره', 'HEAD'], ['الزوج/الزوجه', 'SPOUSE'], ['زوج', 'SPOUSE'], ['زوجه', 'SPOUSE'],
  ['ابن', 'SON'], ['ولد', 'SON'], ['ابنه', 'DAUGHTER'], ['بنت', 'DAUGHTER'], ['الاب', 'FATHER'], ['اب', 'FATHER'],
  ['الام', 'MOTHER'], ['ام', 'MOTHER'], ['اخ', 'BROTHER'], ['اخت', 'SISTER'], ['اخر', 'OTHER'], ['اخري', 'OTHER'],
];
const GENDER_OF: Record<string, 'M' | 'F'> = { SON: 'M', DAUGHTER: 'F', FATHER: 'M', MOTHER: 'F', BROTHER: 'M', SISTER: 'F' };
const TAG_STEMS: [string, string][] = [
  ['يتيم', 'ORPHANS'], ['ايتام', 'ORPHANS'], ['ارمل', 'WIDOW'], ['ارامل', 'WIDOW'], ['معاق', 'DISABLED'], ['مريض', 'SICK'], ['مرضي', 'SICK'],
  ['مطلق', 'DIVORCED'], ['متعفف', 'NEEDY'], ['عانس', 'UNMARRIED'], ['عوانس', 'UNMARRIED'],
];
const INCOME_COLUMNS: [ColumnKey, string][] = [
  ['salary', 'SALARY'], ['pension', 'PENSION'], ['welfare', 'SOCIAL_WELFARE'], ['work', 'WORK'], ['otherAid', 'OTHER_AID'],
];

export type ParsedFamily = {
  form: string;
  /** أرقام الأسطر في الورقة (تبدأ من 2 لأن الأول عناوين). */
  rows: number[];
  headName: string;
  members: number;
  errors: string[];
  payload: Record<string, unknown>;
};
export type ParseResult = { families: ParsedFamily[]; fatal?: string; unknownColumns: string[] };

export function parseSheet(data: Cell[][]): ParseResult {
  const header = data[0] ?? [];
  const index = new Map<ColumnKey, number>();
  const unknownColumns: string[] = [];
  header.forEach((h, i) => {
    const title = str(h);
    if (!title) return;
    const hit = COLUMNS.find(([, label]) => fold(label) === fold(title));
    if (hit) index.set(hit[0], i);
    else unknownColumns.push(title);
  });
  const missing = REQUIRED.filter((k) => !index.has(k)).map((k) => COLUMNS.find(([key]) => key === k)![1]);
  if (missing.length) {
    return { families: [], unknownColumns, fatal: `الورقة تنقصها أعمدة لازمة: ${missing.join('، ')}. نزّل القالب وانقل بياناتك إليه.` };
  }
  const cell = (row: Cell[], key: ColumnKey): Cell => (index.has(key) ? row[index.get(key)!] : undefined);

  const groups = new Map<string, { rows: number[]; lines: Cell[][] }>();
  data.slice(1).forEach((row, i) => {
    if (!row || row.every((c) => c === null || c === undefined || String(c).trim() === '')) return;
    const form = str(cell(row, 'form')) ?? `سطر ${i + 2}`;
    const g = groups.get(form) ?? { rows: [], lines: [] };
    g.rows.push(i + 2);
    g.lines.push(row);
    groups.set(form, g);
  });

  const families: ParsedFamily[] = [];
  for (const [form, g] of groups) {
    const errors: string[] = [];
    let headRow: Cell[] | undefined;
    const members = g.lines.map((row, i) => {
      const at = `السطر ${g.rows[i]}`;
      const relationText = str(cell(row, 'relation'));
      const relation = relationText && RELATION_WORDS.find(([w]) => w === fold(relationText))?.[1];
      if (!relation) errors.push(`${at}: الصلة «${relationText ?? ''}» غير معروفة`);
      if (relation === 'HEAD') headRow ??= row;

      const fullName = str(cell(row, 'fullName'));
      if (!fullName) errors.push(`${at}: الاسم فارغ`);

      const genderText = str(cell(row, 'gender'));
      const g1 = genderText ? fold(genderText) : '';
      const gender = ['ذكر', 'm', 'ذ'].includes(g1) ? 'M' : ['انثي', 'f', 'ا'].includes(g1) ? 'F' : relation ? GENDER_OF[relation] : undefined;
      if (!gender) errors.push(`${at}: الجنس غير مذكور (ذكر أو أنثى)`);

      const birthDate = toDate(cell(row, 'birthDate'));
      if (birthDate === null) errors.push(`${at}: تاريخ الميلاد غير مفهوم. اكتبه هكذا: 1990-05-12`);

      const documents: Record<string, unknown>[] = [];
      const number = str(cell(row, 'docNumber'));
      if (number) {
        const typeText = fold(str(cell(row, 'docType')) ?? '');
        const digits = latinDigits(number).replace(/\D/g, '');
        if (typeText.includes('وطني') || (!typeText && digits.length === 12)) documents.push({ type: 'NATIONAL_CARD', number });
        else if (typeText.includes('احوال')) {
          const register = str(cell(row, 'docRegister')), page = str(cell(row, 'docPage'));
          if (!register || !page) errors.push(`${at}: هوية الأحوال يلزمها السجل والصفحة`);
          else documents.push({ type: 'CIVIL_ID', number, register, page });
        } else if (typeText.includes('جنسيه')) {
          const portfolio = str(cell(row, 'docPortfolio'));
          if (!portfolio) errors.push(`${at}: شهادة الجنسية يلزمها رقم المحفظة`);
          else documents.push({ type: 'NATIONALITY_CERT', number, portfolio });
        } else errors.push(`${at}: نوع الوثيقة غير معروف (بطاقة وطنية، هوية أحوال، شهادة جنسية)`);
      }
      return {
        relation, fullName, motherName: str(cell(row, 'motherName')), gender, birthDate: birthDate ?? undefined,
        status: yes(cell(row, 'deceased')) ? 'DECEASED' : 'ACTIVE', isOrphan: yes(cell(row, 'orphan')),
        disability: str(cell(row, 'disability')), chronicIllness: str(cell(row, 'illness')), documents,
      };
    });

    const heads = members.filter((m) => m.relation === 'HEAD');
    if (heads.length === 0) errors.push('لا رب أسرة في هذه الاستمارة');
    else if (heads.length > 1) errors.push('في الاستمارة أكثر من رب أسرة');
    else if (heads[0].documents.length === 0 && !errors.some((e) => e.includes('الوثيقة') || e.includes('الأحوال') || e.includes('الجنسية'))) {
      errors.push('رب الأسرة بلا وثيقة هوية');
    }

    const h = headRow ?? g.lines[0];
    const tags = new Set<string>();
    for (const part of (str(cell(h, 'tags')) ?? '').split(/[،,;/]+/)) {
      const p = fold(part);
      if (!p) continue;
      const hit = TAG_STEMS.find(([stem]) => p.includes(stem));
      if (hit) tags.add(hit[1]);
      else errors.push(`الفئة «${part.trim()}» غير معروفة`);
    }
    const incomes: { kind: string; amountIqd: number }[] = [];
    for (const [key, kind] of INCOME_COLUMNS) {
      const amount = toAmount(cell(h, key));
      if (amount === null) errors.push(`مبلغ «${COLUMNS.find(([k]) => k === key)![1]}» ليس عدداً صحيحاً`);
      else if (amount > 0) incomes.push({ kind, amountIqd: amount });
    }
    const housingText = fold(str(cell(h, 'housing')) ?? '');
    const housing = !housingText ? undefined : housingText.includes('ملك') ? 'OWNED' : housingText.includes('ايجار') ? 'RENTED' : 'OTHER';
    const ration = str(cell(h, 'ration'));
    const address = {
      mahalla: str(cell(h, 'mahalla')), street: str(cell(h, 'street')), house: str(cell(h, 'house')), landmark: str(cell(h, 'landmark')),
    };

    families.push({
      form, rows: g.rows, headName: heads[0]?.fullName ?? members[0]?.fullName ?? '—', members: members.length, errors,
      payload: {
        tags: [...tags], phone1: toPhone(cell(h, 'phone1')), phone2: toPhone(cell(h, 'phone2')),
        hasWhatsapp: index.has('whatsapp') && str(cell(h, 'whatsapp')) !== undefined ? yes(cell(h, 'whatsapp')) : true,
        prefersVoice: yes(cell(h, 'cannotRead')), address, housing,
        housingOther: housing === 'OTHER' ? str(cell(h, 'housing')) : undefined,
        rationCard: ration ? { number: ration } : undefined, notes: str(cell(h, 'notes')),
        members, incomes, proxies: [],
      },
    });
  }
  return { families, unknownColumns };
}

/** صفوف القالب: العناوين ثم عائلة مثالاً من ثلاثة أفراد. */
export function templateRows(): string[][] {
  const row = (values: Partial<Record<ColumnKey, string>>) => COLUMNS.map(([key]) => values[key] ?? '');
  return [
    COLUMNS.map(([, label]) => label),
    row({
      form: '1', relation: 'رب الأسرة', fullName: 'سعاد كريم عبد الله الدليمي', motherName: 'فاطمة حسن', gender: 'أنثى', birthDate: '1985-03-14',
      docType: 'بطاقة وطنية', docNumber: '198512345678', phone1: '07701234567', whatsapp: 'نعم', mahalla: 'الجولان', street: '12', house: '7',
      landmark: 'قرب الجامع', housing: 'إيجار', ration: '4455667', tags: 'أرامل، أيتام', welfare: '150000', notes: 'مثال: احذف هذه الأسطر الثلاثة',
    }),
    row({ form: '1', relation: 'ابن', fullName: 'علي أحمد جاسم الدليمي', birthDate: '2012-09-01', orphan: 'نعم' }),
    row({
      form: '1', relation: 'ابنة', fullName: 'زينب أحمد جاسم الدليمي', birthDate: '2015-01-20', orphan: 'نعم',
      docType: 'هوية أحوال', docNumber: '00123456', docRegister: '45', docPage: '112',
    }),
  ];
}
