import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Attachments } from '../components/Attachments';
import { DocumentFields, isDocComplete, type DocDraft } from '../components/DocumentFields';
import { useToast } from '../components/toast';
import { Alert, Button, Card, Field, Input, PageHeader, Select } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatNumber, digits } from '../lib/format';
import { DOC_TYPES, FAMILY_STATUS, HOUSING, INCOME_KINDS, RELATIONS, TAGS, type Housing, type IncomeKind, type Relation, type Tag } from '../lib/labels';
import type { Conflict, Family } from '../lib/types';

interface MemberDraft {
  relation: Relation; fullName: string; motherName: string; gender: 'M' | 'F'; birthDate: string;
  status: 'ACTIVE' | 'DECEASED'; isOrphan: boolean; disability: string; chronicIllness: string;
  hasDoc: boolean; doc: DocDraft;
}
interface Draft {
  clientOpId: string; tags: Tag[]; phone1: string; phone2: string; hasWhatsapp: boolean; prefersVoice: boolean;
  mahalla: string; street: string; house: string; landmark: string;
  housing: Housing | ''; housingOther: string; prevAddress: string; prevLandmark: string;
  rationNumber: string; rationCenter: string; residenceNumber: string; residenceBy: string;
  members: MemberDraft[]; incomes: { kind: IncomeKind; amount: string }[];
  proxies: { fullName: string; phone: string; relation: string }[]; notes: string;
  /** الطلب السريع الذي تُستكمل به هذه الاستمارة، ورقمه للعرض. */
  quickRequestId?: string; quickNo?: number;
}

const emptyMember = (relation: Relation): MemberDraft => ({
  relation, fullName: '', motherName: '', gender: 'M', birthDate: '', status: 'ACTIVE', isOrphan: false,
  disability: '', chronicIllness: '', hasDoc: relation === 'HEAD', doc: { type: 'NATIONAL_CARD', number: '' },
});
const emptyDraft = (): Draft => ({
  clientOpId: crypto.randomUUID(), tags: [], phone1: '', phone2: '', hasWhatsapp: true, prefersVoice: false, mahalla: '', street: '', house: '', landmark: '',
  housing: '', housingOther: '', prevAddress: '', prevLandmark: '', rationNumber: '', rationCenter: '',
  residenceNumber: '', residenceBy: '', members: [emptyMember('HEAD')], incomes: [], proxies: [], notes: '',
});

// المسودة في sessionStorage: تنجو من تحديث الصفحة وتزول بإغلاق التبويب، فلا تبقى بيانات العوائل على حاسوب مشترك.
const DRAFT_KEY = 'eywaa.registerDraft';
function loadDraft(): Draft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw) as Draft;
  } catch { /* مسودة تالفة: نبدأ من جديد */ }
  return emptyDraft();
}

const STEPS = ['رب الأسرة', 'الأفراد', 'السكن والوثائق', 'الدخل والوكلاء', 'المراجعة والحفظ'];
const opt = (s: string) => (s.trim() ? s.trim() : undefined);

function toPayload(d: Draft) {
  return {
    clientOpId: d.clientOpId,
    tags: d.tags,
    quickRequestId: d.quickRequestId,
    phone1: opt(d.phone1), phone2: opt(d.phone2), hasWhatsapp: d.hasWhatsapp ?? true, prefersVoice: d.prefersVoice ?? false,
    address: { mahalla: opt(d.mahalla), street: opt(d.street), house: opt(d.house), landmark: opt(d.landmark) },
    housing: d.housing || undefined, housingOther: opt(d.housingOther),
    prevAddress: opt(d.prevAddress), prevLandmark: opt(d.prevLandmark),
    rationCard: opt(d.rationNumber) ? { number: d.rationNumber, center: opt(d.rationCenter) } : undefined,
    residenceCard: opt(d.residenceNumber) ? { number: d.residenceNumber, issuedBy: opt(d.residenceBy) } : undefined,
    notes: opt(d.notes),
    members: d.members.map((m) => ({
      relation: m.relation, fullName: m.fullName.trim(), motherName: opt(m.motherName), gender: m.gender,
      birthDate: opt(m.birthDate), status: m.status, isOrphan: m.isOrphan,
      disability: opt(m.disability), chronicIllness: opt(m.chronicIllness),
      documents: m.hasDoc && isDocComplete(m.doc) ? [m.doc] : [],
    })),
    incomes: d.incomes.filter((i) => i.amount.trim()).map((i) => ({ kind: i.kind, amountIqd: Number(digits(i.amount)) })),
    proxies: d.proxies.filter((p) => p.fullName.trim()).map((p) => ({ fullName: p.fullName.trim(), phone: opt(p.phone), relation: opt(p.relation) })),
  };
}

function MemberCard({ m, index, onChange, onRemove, onDuplicate }: {
  m: MemberDraft; index: number; onChange: (m: MemberDraft) => void; onRemove?: () => void; onDuplicate: (dup: boolean) => void;
}) {
  const set = (patch: Partial<MemberDraft>) => onChange({ ...m, ...patch });
  const isHead = m.relation === 'HEAD';
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line p-4">
      {!isHead && (
        <div className="flex items-center justify-between gap-3">
          <strong>الفرد {index + 1}</strong>
          <Button variant="danger" onClick={onRemove}>حذف</Button>
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3">
        <div className="col-span-full">
          <Field label={isHead ? 'الاسم الرباعي واللقب' : 'الاسم الكامل'}>
            {(id) => <Input id={id} name={`member-${index}-name`} value={m.fullName} onChange={(e) => set({ fullName: e.target.value })} />}
          </Field>
        </div>
        {!isHead && (
          <Field label="الصلة برب الأسرة">
            {(id) => (
              <Select id={id} value={m.relation} onChange={(e) => set({ relation: e.target.value as Relation })}>
                {Object.entries(RELATIONS).filter(([k]) => k !== 'HEAD').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            )}
          </Field>
        )}
        <Field label="اسم الأم الكامل">{(id) => <Input id={id} value={m.motherName} onChange={(e) => set({ motherName: e.target.value })} />}</Field>
        <Field label="الجنس">
          {(id) => <Select id={id} value={m.gender} onChange={(e) => set({ gender: e.target.value as 'M' | 'F' })}><option value="M">ذكر</option><option value="F">أنثى</option></Select>}
        </Field>
        <Field label="المواليد">{(id) => <Input id={id} type="date" value={m.birthDate} onChange={(e) => set({ birthDate: e.target.value })} />}</Field>
        <Field label="نوع الإعاقة إن وُجدت">{(id) => <Input id={id} value={m.disability} onChange={(e) => set({ disability: e.target.value })} />}</Field>
        <Field label="المرض المزمن إن وُجد">{(id) => <Input id={id} value={m.chronicIllness} onChange={(e) => set({ chronicIllness: e.target.value })} />}</Field>
      </div>
      {!isHead && (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={m.isOrphan} onChange={(e) => set({ isOrphan: e.target.checked })} />يتيم</label>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={m.status === 'DECEASED'} onChange={(e) => set({ status: e.target.checked ? 'DECEASED' : 'ACTIVE' })} />متوفى</label>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={m.hasDoc} onChange={(e) => set({ hasDoc: e.target.checked })} />له وثيقة هوية</label>
        </div>
      )}
      {m.hasDoc && <DocumentFields idPrefix={`member-${index}`} value={m.doc} onChange={(doc) => set({ doc })} onDuplicate={onDuplicate} />}
    </div>
  );
}

export function Register() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const quick = (useLocation().state as { quick?: { id: string; no: number; headName: string; phone: string | null; mahalla: string | null; landmark: string | null } } | null)?.quick;
  // استكمال طلب سريع: تبدأ الاستمارة بما فيه، ويُغلق الطلب بحفظها.
  const [draft, setDraft] = useState<Draft>(() => (quick
    ? { ...emptyDraft(), quickRequestId: quick.id, quickNo: quick.no, phone1: quick.phone ?? '', mahalla: quick.mahalla ?? '', landmark: quick.landmark ?? '', members: [{ ...emptyMember('HEAD'), fullName: quick.headName }] }
    : loadDraft()));
  const [step, setStep] = useState(0);
  const [dups, setDups] = useState<Record<number, boolean>>({});
  const [rationHit, setRationHit] = useState<{ found: boolean; familyId?: string; familyNo?: string } | null>(null);
  const [created, setCreated] = useState<Family | null>(null);
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  useEffect(() => {
    if (created) return;
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* يعمل بلا حفظ */ }
  }, [draft, created]);

  useEffect(() => {
    setRationHit(null);
    if (!draft.rationNumber.trim()) return;
    const t = setTimeout(() => {
      api<{ found: boolean; familyId?: string; familyNo?: string }>('/families/lookup/ration-card', { method: 'POST', body: { number: draft.rationNumber } })
        .then(setRationHit).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [draft.rationNumber]);

  const save = useMutation({
    mutationFn: () => api<Family>('/families', { method: 'POST', body: toPayload(draft) }),
    onSuccess: (family) => {
      try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* لا شيء */ }
      queryClient.invalidateQueries({ queryKey: ['families'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      setCreated(family);
      toast(`سُجّلت العائلة ${family.familyNo}`);
    },
  });

  const head = draft.members[0];
  const setMember = (i: number, m: MemberDraft) => patch({ members: draft.members.map((x, j) => (j === i ? m : x)) });
  const anyDup = Object.values(dups).some(Boolean) || !!rationHit?.found;
  const problems: string[] = [];
  if (!head.fullName.trim()) problems.push('اكتب اسم رب الأسرة.');
  if (!isDocComplete(head.doc)) problems.push('أكمل وثيقة رب الأسرة.');
  if (draft.members.slice(1).some((m) => !m.fullName.trim())) problems.push('في الأفراد فرد بلا اسم.');
  if (draft.members.some((m) => m.hasDoc && m.relation !== 'HEAD' && !isDocComplete(m.doc))) problems.push('في الأفراد وثيقة ناقصة: أكملها أو ألغِ علامة «له وثيقة».');
  if (anyDup) problems.push('في الاستمارة وثيقة أو بطاقة تموينية مسجَّلة سلفاً.');

  const stepBlocked = step === 0 ? !head.fullName.trim() || !isDocComplete(head.doc) || !!dups[0] : false;
  const conflicts = save.error instanceof ApiError ? ((save.error.details as { conflicts?: Conflict[] })?.conflicts ?? []) : [];
  const fieldErrors = save.error instanceof ApiError ? ((save.error.details as { errors?: { path: string; message: string }[] })?.errors ?? []) : [];

  if (created) {
    return (
      <>
        <PageHeader title={`سُجّلت العائلة ${created.familyNo}`} description="بقيت المرفقات، وهي اختيارية." />
        <Alert tone={created.status === 'PENDING_DEDUPE_REVIEW' ? 'warn' : 'ok'}>
          {created.status === 'PENDING_DEDUPE_REVIEW'
            ? <><strong>عُلّق السجل لشبهة تكرار.</strong> في النظام شخص يشبه أحد أفراد هذه العائلة. يفصل فيها مراجع غيرك قبل الاعتماد.</>
            : <><strong>السجل في صف الاعتماد.</strong> يعتمده موظف غيرك، ثم تُحسب نقاط العائلة.</>}
        </Alert>
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">المرفقات</h2>
          <Attachments familyId={created.id} canUpload canDelete={false} />
        </Card>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => { setCreated(null); setDraft(emptyDraft()); setStep(0); setDups({}); save.reset(); }}>سجّل عائلة أخرى</Button>
          <Button onClick={() => navigate(`/families/${created.id}`)}>افتح ملف العائلة</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={draft.quickNo ? `استكمال طلب التسجيل ${draft.quickNo}` : 'تسجيل عائلة'}
        description={draft.quickNo ? 'أكمل الاستمارة من وثائق العائلة. بحفظها يُغلق الطلب السريع.' : 'على ترتيب الاستمارة الورقية. ما تكتبه محفوظ حتى تغلق التبويب.'}
        action={<Button variant="ghost" onClick={() => { setDraft(emptyDraft()); setStep(0); setDups({}); }}>ابدأ من جديد</Button>}
      />
      <ol aria-label="خطوات التسجيل" className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              aria-current={i === step ? 'step' : undefined}
              disabled={i > step && stepBlocked}
              onClick={() => setStep(i)}
              className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-start font-semibold disabled:opacity-60 ${i === step ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line bg-surface'}`}
            >
              <span aria-hidden="true" className={`flex size-7 flex-none items-center justify-center rounded-full ${i === step ? 'bg-brand text-white' : i < step ? 'bg-brand-soft text-brand-strong' : 'bg-ground text-muted'}`}>{i < step ? '✓' : i + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      <Card className="flex flex-col gap-5">
        {step === 0 && (
          <>
            <h2 className="text-lg font-bold">رب الأسرة ووثيقته</h2>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">فئة العائلة (يجوز أكثر من واحدة)</legend>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(TAGS) as Tag[]).map((t) => (
                  <label key={t} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-3.5">
                    <input type="checkbox" className="size-[18px] accent-brand" checked={draft.tags.includes(t)}
                      onChange={(e) => patch({ tags: e.target.checked ? [...draft.tags, t] : draft.tags.filter((x) => x !== t) })} />
                    {TAGS[t]}
                  </label>
                ))}
              </div>
            </fieldset>
            <MemberCard m={head} index={0} onChange={(m) => setMember(0, m)} onDuplicate={(dup) => setDups((d) => ({ ...d, 0: dup }))} />
            <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3">
              <Field label="الهاتف">{(id) => <Input id={id} dir="ltr" inputMode="tel" placeholder="07XXXXXXXXX" value={draft.phone1} onChange={(e) => patch({ phone1: e.target.value })} />}</Field>
              <Field label="هاتف ثانٍ (اختياري)">{(id) => <Input id={id} dir="ltr" inputMode="tel" value={draft.phone2} onChange={(e) => patch({ phone2: e.target.value })} />}</Field>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={draft.hasWhatsapp ?? true} onChange={(e) => patch({ hasWhatsapp: e.target.checked })} />على هذا الهاتف واتساب</label>
              <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={draft.prefersVoice ?? false} onChange={(e) => patch({ prefersVoice: e.target.checked })} />لا يقرأ: يُبلَّغ بمكالمة</label>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h2 className="text-lg font-bold">أفراد العائلة</h2>
            <p className="text-muted">سجّل كل فرد باسمه، والمتوفى كذلك مع علامة «متوفى». عدد الأفراد يُحسب من هذه القائمة.</p>
            {draft.members.slice(1).map((m, i) => (
              <MemberCard key={i} m={m} index={i + 1} onChange={(x) => setMember(i + 1, x)}
                onRemove={() => { patch({ members: draft.members.filter((_, j) => j !== i + 1) }); setDups({ 0: !!dups[0] }); }}
                onDuplicate={(dup) => setDups((d) => ({ ...d, [i + 1]: dup }))} />
            ))}
            <Button variant="secondary" className="self-start" onClick={() => patch({ members: [...draft.members, emptyMember('SON')] })}>أضف فرداً</Button>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="text-lg font-bold">السكن والوثائق العائلية</h2>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
              <Field label="المحلة">{(id) => <Input id={id} value={draft.mahalla} onChange={(e) => patch({ mahalla: e.target.value })} />}</Field>
              <Field label="الزقاق أو الشارع">{(id) => <Input id={id} value={draft.street} onChange={(e) => patch({ street: e.target.value })} />}</Field>
              <Field label="الدار">{(id) => <Input id={id} value={draft.house} onChange={(e) => patch({ house: e.target.value })} />}</Field>
              <Field label="أقرب نقطة دالة">{(id) => <Input id={id} value={draft.landmark} onChange={(e) => patch({ landmark: e.target.value })} />}</Field>
              <Field label="نوع العقار">
                {(id) => (
                  <Select id={id} value={draft.housing} onChange={(e) => patch({ housing: e.target.value as Housing | '' })}>
                    <option value="">لم يُحدَّد</option>
                    {Object.entries(HOUSING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                )}
              </Field>
              {draft.housing === 'OTHER' && <Field label="اذكر نوعه">{(id) => <Input id={id} value={draft.housingOther} onChange={(e) => patch({ housingOther: e.target.value })} />}</Field>}
              <Field label="عنوان السكن السابق">{(id) => <Input id={id} value={draft.prevAddress} onChange={(e) => patch({ prevAddress: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3 border-t border-line pt-4">
              <Field label="رقم البطاقة التموينية" error={rationHit?.found ? `مسجَّلة للعائلة ${rationHit.familyNo}` : undefined} hint="لا تتكرر بين عائلتين">
                {(id) => <Input id={id} dir="ltr" inputMode="numeric" className={rationHit?.found ? 'border-2 !border-danger' : ''} value={draft.rationNumber} onChange={(e) => patch({ rationNumber: e.target.value })} />}
              </Field>
              <Field label="اسم مركز التموين">{(id) => <Input id={id} value={draft.rationCenter} onChange={(e) => patch({ rationCenter: e.target.value })} />}</Field>
              <Field label="رقم بطاقة السكن">{(id) => <Input id={id} dir="ltr" value={draft.residenceNumber} onChange={(e) => patch({ residenceNumber: e.target.value })} />}</Field>
              <Field label="جهة إصدارها">{(id) => <Input id={id} value={draft.residenceBy} onChange={(e) => patch({ residenceBy: e.target.value })} />}</Field>
            </div>
            {rationHit?.found && (
              <Alert><strong>هذه البطاقة التموينية مسجَّلة سلفاً</strong> للعائلة {rationHit.familyNo}. <Link className="font-bold underline" to={`/families/${rationHit.familyId}`}>افتح السجل القائم</Link></Alert>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <h2 className="text-lg font-bold">الدخل الشهري</h2>
            <p className="text-muted">كل مصدر دخل بمبلغه بالدينار. إن لم يكن للعائلة دخل فاتركه فارغاً.</p>
            {draft.incomes.map((inc, i) => (
              <div key={i} className="flex flex-wrap items-end gap-3">
                <div className="min-w-44 flex-1">
                  <Field label="المصدر">
                    {(id) => (
                      <Select id={id} value={inc.kind} onChange={(e) => patch({ incomes: draft.incomes.map((x, j) => (j === i ? { ...x, kind: e.target.value as IncomeKind } : x)) })}>
                        {Object.entries(INCOME_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </Select>
                    )}
                  </Field>
                </div>
                <div className="min-w-40 flex-1">
                  <Field label="المبلغ بالدينار">
                    {(id) => <Input id={id} dir="ltr" inputMode="numeric" value={inc.amount} onChange={(e) => patch({ incomes: draft.incomes.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) })} />}
                  </Field>
                </div>
                <Button variant="danger" onClick={() => patch({ incomes: draft.incomes.filter((_, j) => j !== i) })}>حذف</Button>
              </div>
            ))}
            <Button variant="secondary" className="self-start" onClick={() => patch({ incomes: [...draft.incomes, { kind: 'SALARY', amount: '' }] })}>أضف مصدر دخل</Button>

            <h2 className="border-t border-line pt-4 text-lg font-bold">الوكلاء</h2>
            <p className="text-muted">من يجوز له أن يستلم عن العائلة غير ربّها. لا يستلم إلا مسجَّل هنا.</p>
            {draft.proxies.map((px, i) => (
              <div key={i} className="flex flex-wrap items-end gap-3">
                <div className="min-w-48 flex-[2]"><Field label="اسم الوكيل">{(id) => <Input id={id} value={px.fullName} onChange={(e) => patch({ proxies: draft.proxies.map((x, j) => (j === i ? { ...x, fullName: e.target.value } : x)) })} />}</Field></div>
                <div className="min-w-36 flex-1"><Field label="صلته">{(id) => <Input id={id} value={px.relation} onChange={(e) => patch({ proxies: draft.proxies.map((x, j) => (j === i ? { ...x, relation: e.target.value } : x)) })} />}</Field></div>
                <div className="min-w-40 flex-1"><Field label="هاتفه">{(id) => <Input id={id} dir="ltr" inputMode="tel" value={px.phone} onChange={(e) => patch({ proxies: draft.proxies.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)) })} />}</Field></div>
                <Button variant="danger" onClick={() => patch({ proxies: draft.proxies.filter((_, j) => j !== i) })}>حذف</Button>
              </div>
            ))}
            <Button variant="secondary" className="self-start" onClick={() => patch({ proxies: [...draft.proxies, { fullName: '', phone: '', relation: '' }] })}>أضف وكيلاً</Button>
          </>
        )}

        {step === 4 && (
          <>
            <h2 className="text-lg font-bold">راجع قبل الحفظ</h2>
            <dl className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-x-6 gap-y-3">
              <div><dt className="text-sm text-muted">رب الأسرة</dt><dd className="font-semibold">{head.fullName || '—'}</dd></div>
              <div><dt className="text-sm text-muted">وثيقته</dt><dd className="font-semibold">{DOC_TYPES[head.doc.type]}</dd></div>
              <div><dt className="text-sm text-muted">الفئات</dt><dd className="font-semibold">{draft.tags.map((t) => TAGS[t]).join('، ') || '—'}</dd></div>
              <div><dt className="text-sm text-muted">عدد الأفراد الأحياء</dt><dd className="font-semibold">{draft.members.filter((m) => m.status === 'ACTIVE').length}</dd></div>
              <div><dt className="text-sm text-muted">نوع العقار</dt><dd className="font-semibold">{draft.housing ? HOUSING[draft.housing] : '—'}</dd></div>
              <div><dt className="text-sm text-muted">مجموع الدخل الشهري</dt><dd className="font-semibold">{formatNumber(draft.incomes.reduce((s, i) => s + (Number(digits(i.amount)) || 0), 0))} دينار</dd></div>
              <div><dt className="text-sm text-muted">الوكلاء</dt><dd className="font-semibold">{draft.proxies.filter((p) => p.fullName.trim()).length}</dd></div>
            </dl>
            <Field label="ملاحظات (اختيارية)">{(id) => <Input id={id} value={draft.notes} onChange={(e) => patch({ notes: e.target.value })} />}</Field>
            {problems.length > 0 && <Alert tone="warn"><strong>لا يُحفظ قبل إصلاح الآتي:</strong><ul className="list-inside list-disc">{problems.map((p) => <li key={p}>{p}</li>)}</ul></Alert>}
            {conflicts.length > 0 && (
              <Alert>
                <strong>مسجَّل سلفاً.</strong>
                <ul className="list-inside list-disc">
                  {conflicts.map((c, i) => (
                    <li key={i}>
                      {c.kind === 'RATION_CARD' ? 'البطاقة التموينية' : `وثيقة ${draft.members[c.memberIndex ?? 0]?.fullName || 'فرد'}`}
                      {' '}مسجَّلة للعائلة {c.familyNo} ({FAMILY_STATUS[c.familyStatus].label}){c.personName ? ` باسم «${c.personName}»` : ''}.
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {save.error && conflicts.length === 0 && (
              <Alert>{save.error.message}{fieldErrors.length > 0 && <ul className="list-inside list-disc">{fieldErrors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>}</Alert>
            )}
          </>
        )}

        <div className="flex flex-wrap justify-between gap-3 border-t border-line pt-4">
          <Button variant="secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>السابق</Button>
          {step < 4
            ? <Button disabled={stepBlocked} onClick={() => setStep(step + 1)}>التالي: {STEPS[step + 1]}</Button>
            : <Button disabled={problems.length > 0 || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'جارٍ الحفظ…' : 'احفظ وأرسل للاعتماد'}</Button>}
        </div>
      </Card>
    </>
  );
}
