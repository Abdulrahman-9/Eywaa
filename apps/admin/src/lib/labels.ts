export const FAMILY_STATUS = {
  APPROVED: { label: 'معتمد', tone: 'ok' },
  PENDING_APPROVAL: { label: 'بانتظار الاعتماد', tone: 'warn' },
  PENDING_DEDUPE_REVIEW: { label: 'شبهة تكرار', tone: 'info' },
  REJECTED: { label: 'مرفوض', tone: 'danger' },
} as const;
export type FamilyStatus = keyof typeof FAMILY_STATUS;

export const TAGS = {
  ORPHANS: 'أيتام', WIDOW: 'أرامل', DISABLED: 'معاقون', SICK: 'مرضى',
  DIVORCED: 'مطلقات', NEEDY: 'متعففون', UNMARRIED: 'عوانس',
} as const;
export type Tag = keyof typeof TAGS;

export const RELATIONS = {
  HEAD: 'رب الأسرة', SPOUSE: 'الزوج/الزوجة', SON: 'ابن', DAUGHTER: 'ابنة', FATHER: 'الأب',
  MOTHER: 'الأم', BROTHER: 'أخ', SISTER: 'أخت', OTHER: 'آخر',
} as const;
export type Relation = keyof typeof RELATIONS;

export const DOC_TYPES = {
  NATIONAL_CARD: 'البطاقة الوطنية الموحدة',
  CIVIL_ID: 'هوية الأحوال المدنية',
  NATIONALITY_CERT: 'شهادة الجنسية',
} as const;
export type DocType = keyof typeof DOC_TYPES;

export const HOUSING = { OWNED: 'ملك', RENTED: 'إيجار', OTHER: 'أخرى' } as const;
export type Housing = keyof typeof HOUSING;

export const INCOME_KINDS = {
  SALARY: 'راتب', PENSION: 'راتب تقاعدي', SOCIAL_WELFARE: 'رعاية اجتماعية', WORK: 'عمل حر', OTHER_AID: 'إعانة من جهة أخرى',
} as const;
export type IncomeKind = keyof typeof INCOME_KINDS;

export const ATTACHMENT_CATEGORIES = {
  PHOTO: 'صورة شخصية', IDENTITY: 'وثيقة هوية', RATION_CARD: 'البطاقة التموينية', RESIDENCE_CARD: 'بطاقة السكن',
  MEDICAL: 'تقرير طبي', PAPER_FORM: 'الاستمارة الورقية', OTHER: 'أخرى',
} as const;
export type AttachmentCategory = keyof typeof ATTACHMENT_CATEGORIES;

export const CHANGE_TYPES = {
  UPDATE_FAMILY: 'تعديل بيانات العائلة', SET_INCOMES: 'تعديل الدخل', SET_PROXIES: 'تبديل الوكلاء',
  ADD_MEMBER: 'إضافة فرد', UPDATE_MEMBER: 'تغيير حال فرد', ADD_DOCUMENT: 'إضافة وثيقة',
} as const;
export type ChangeType = keyof typeof CHANGE_TYPES;

export const CHANGE_STATUS = {
  PENDING: { label: 'ينتظر الاعتماد', tone: 'warn' },
  APPROVED: { label: 'معتمد', tone: 'ok' },
  REJECTED: { label: 'مرفوض', tone: 'danger' },
} as const;

const FIELD_LABELS: Record<string, string> = {
  tags: 'الفئات', phone1: 'الهاتف', phone2: 'هاتف ثانٍ', mahalla: 'المحلة', street: 'الزقاق أو الشارع', house: 'الدار',
  landmark: 'أقرب نقطة دالة', housing: 'نوع العقار', housingOther: 'تفصيل العقار', notes: 'ملاحظات',
  status: 'الحال', isOrphan: 'يتيم', disability: 'الإعاقة', chronicIllness: 'المرض المزمن',
};
export const fieldLabel = (key: string) => FIELD_LABELS[key] ?? key;
