import { useRef, useState } from 'react';
import { compress } from '../lib/image';
import { app, getState } from '../lib/store';
import { Button, Field, Notice, Screen, SelectField } from '../ui';

const TAGS = { ORPHANS: 'أيتام', WIDOW: 'أرامل', DISABLED: 'معاقون', SICK: 'مرضى', DIVORCED: 'مطلقات', NEEDY: 'متعففون', UNMARRIED: 'عوانس' } as const;
const RELATIONS = { SPOUSE: 'الزوج/الزوجة', SON: 'ابن', DAUGHTER: 'ابنة', FATHER: 'الأب', MOTHER: 'الأم', BROTHER: 'أخ', SISTER: 'أخت', OTHER: 'آخر' } as const;
const GENDER: Record<string, 'M' | 'F' | ''> = { SON: 'M', DAUGHTER: 'F', FATHER: 'M', MOTHER: 'F', BROTHER: 'M', SISTER: 'F', SPOUSE: '', OTHER: '' };
const INCOMES = { SALARY: 'راتب', PENSION: 'راتب تقاعدي', SOCIAL_WELFARE: 'رعاية اجتماعية', WORK: 'عمل حر', OTHER_AID: 'إعانة من جهة أخرى' } as const;
const PHOTO_KINDS = { IDENTITY: 'وثيقة هوية', RATION_CARD: 'البطاقة التموينية', PAPER_FORM: 'الاستمارة الورقية', OTHER: 'أخرى' } as const;
const ASCII = (v: string) => v.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const digits = (v: string) => ASCII(v).replace(/\D/g, '');

type DocType = 'NATIONAL_CARD' | 'CIVIL_ID' | 'NATIONALITY_CERT';
interface Member { fullName: string; relation: keyof typeof RELATIONS; gender: 'M' | 'F'; birthDate: string; isOrphan: boolean }

/** تسجيل عائلة والجهاز منقطع. يُحفظ على الجهاز مشفّراً، ويُرفع عند المزامنة فيمرّ بكشف التكرار والاعتماد. */
export function Register({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [head, setHead] = useState({ fullName: '', motherName: '', gender: 'M' as 'M' | 'F', birthDate: '', phone: '', hasWhatsapp: true, prefersVoice: false });
  const [doc, setDoc] = useState({ type: 'NATIONAL_CARD' as DocType, number: '', register: '', page: '', portfolio: '' });
  const [tags, setTags] = useState<string[]>([]);
  const [home, setHome] = useState({ mahalla: '', landmark: '', housing: '' as '' | 'OWNED' | 'RENTED' | 'OTHER', ration: '' });
  const [members, setMembers] = useState<Member[]>([]);
  const [incomes, setIncomes] = useState<Record<string, string>>({});
  const [proxy, setProxy] = useState('');
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [photos, setPhotos] = useState<{ bytes: Uint8Array; category: keyof typeof PHOTO_KINDS; url: string }[]>([]);
  const [photoKind, setPhotoKind] = useState<keyof typeof PHOTO_KINDS>('IDENTITY');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  function document() {
    const number = ASCII(doc.number).trim();
    if (doc.type === 'NATIONAL_CARD') return { type: doc.type, number: digits(number) };
    if (doc.type === 'CIVIL_ID') return { type: doc.type, number, register: ASCII(doc.register).trim(), page: ASCII(doc.page).trim() };
    return { type: doc.type, number, portfolio: ASCII(doc.portfolio).trim() };
  }

  function validate(): string[] {
    const e: string[] = [];
    const d = document();
    if (head.fullName.trim().split(/\s+/).length < 3) e.push('اكتب اسم رب الأسرة ثلاثياً على الأقل.');
    if (d.type === 'NATIONAL_CARD' && !/^\d{12}$/.test(d.number)) e.push('رقم البطاقة الوطنية 12 خانة.');
    if (d.type === 'CIVIL_ID' && !(d.number && d.register && d.page)) e.push('هوية الأحوال يلزمها الرقم والسجل والصفحة.');
    if (d.type === 'NATIONALITY_CERT' && !(d.number && d.portfolio)) e.push('شهادة الجنسية يلزمها الرقم ورقم المحفظة.');
    const phone = digits(head.phone);
    if (phone && !/^(964|0)?7\d{9}$/.test(phone)) e.push('رقم الهاتف غير صالح. مثاله: 07701234567');
    if (members.some((m) => !m.fullName.trim())) e.push('في الأفراد اسم فارغ. اكتبه أو احذف السطر.');
    const same = getState().registrations.find((r) => r.sync === 'PENDING' && JSON.stringify((r.payload.members as { documents: unknown[] }[])[0].documents[0]) === JSON.stringify(d));
    if (same) e.push(`هذه الوثيقة سجّلتَ بها «${same.headName}» على هذا الجهاز ولم تُرفع بعد.`);
    return e;
  }

  async function save() {
    const found = validate();
    setErrors(found);
    if (found.length) { window.scrollTo({ top: 0 }); return; }
    setBusy(true);
    const clientOpId = crypto.randomUUID();
    const text = (v: string) => v.trim() || undefined;
    const payload = {
      tags, phone1: digits(head.phone) || undefined, hasWhatsapp: head.hasWhatsapp, prefersVoice: head.prefersVoice,
      address: { mahalla: text(home.mahalla), landmark: text(home.landmark) }, housing: home.housing || undefined,
      rationCard: digits(home.ration) ? { number: digits(home.ration) } : undefined, location: location ?? undefined,
      members: [
        { relation: 'HEAD', fullName: head.fullName.trim(), motherName: text(head.motherName), gender: head.gender, birthDate: head.birthDate || undefined, documents: [document()] },
        ...members.map((m) => ({ relation: m.relation, fullName: m.fullName.trim(), gender: m.gender, birthDate: m.birthDate || undefined, isOrphan: m.isOrphan, documents: [] })),
      ],
      incomes: Object.entries(incomes).map(([kind, v]) => ({ kind, amountIqd: Number(digits(v)) })).filter((i) => i.amountIqd > 0),
      proxies: proxy.trim() ? [{ fullName: proxy.trim() }] : [],
    };
    await app.addRegistration(
      { clientOpId, createdAt: new Date().toISOString(), headName: head.fullName.trim(), payload, sync: 'PENDING', photos: photos.map((p, i) => ({ key: `reg:${clientOpId}:${i}`, category: p.category })) },
      photos.map((p) => p.bytes),
    );
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    if (getState().online) void app.sync();
    onSaved();
  }

  function locate() {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setLocation({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }); setLocating(false); },
      () => setLocating(false), { enableHighAccuracy: true, timeout: 15_000 });
  }

  async function addPhoto(file: File | undefined) {
    if (!file) return;
    try {
      const bytes = await compress(file);
      setPhotos((all) => [...all, { bytes, category: photoKind, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' })) }]);
    } catch { setErrors(['تعذّرت قراءة الصورة.']); }
    if (photoInput.current) photoInput.current.value = '';
  }

  const section = 'flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface p-4';
  return (
    <Screen title="تسجيل عائلة" onBack={onBack}>
      {errors.length > 0 && <Notice><ul className="list-inside list-disc">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Notice>}

      <section className={section} aria-label="رب الأسرة">
        <h2 className="text-lg font-bold">رب الأسرة</h2>
        <Field label="الاسم الرباعي واللقب" value={head.fullName} onChange={(e) => setHead({ ...head, fullName: e.target.value })} />
        <Field label="اسم الأم" value={head.motherName} onChange={(e) => setHead({ ...head, motherName: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="الجنس" value={head.gender} onChange={(e) => setHead({ ...head, gender: e.target.value as 'M' | 'F' })}><option value="M">ذكر</option><option value="F">أنثى</option></SelectField>
          <Field label="المواليد" type="date" value={head.birthDate} onChange={(e) => setHead({ ...head, birthDate: e.target.value })} />
        </div>
        <SelectField label="نوع الوثيقة" value={doc.type} onChange={(e) => setDoc({ ...doc, type: e.target.value as DocType })}>
            <option value="NATIONAL_CARD">البطاقة الوطنية الموحدة</option><option value="CIVIL_ID">هوية الأحوال المدنية (القديمة)</option><option value="NATIONALITY_CERT">شهادة الجنسية</option>
          </SelectField>
        <Field label="رقم الوثيقة" hint={doc.type === 'NATIONAL_CARD' ? '12 خانة' : undefined} inputMode="numeric" dir="ltr" value={doc.number} onChange={(e) => setDoc({ ...doc, number: e.target.value })} />
        {doc.type === 'CIVIL_ID' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="السجل" dir="ltr" value={doc.register} onChange={(e) => setDoc({ ...doc, register: e.target.value })} />
            <Field label="الصفحة" dir="ltr" value={doc.page} onChange={(e) => setDoc({ ...doc, page: e.target.value })} />
          </div>
        )}
        {doc.type === 'NATIONALITY_CERT' && <Field label="رقم المحفظة" dir="ltr" value={doc.portfolio} onChange={(e) => setDoc({ ...doc, portfolio: e.target.value })} />}
        <Field label="الهاتف" type="tel" inputMode="tel" dir="ltr" value={head.phone} onChange={(e) => setHead({ ...head, phone: e.target.value })} />
        <label className="flex min-h-12 items-center gap-3 font-semibold"><input type="checkbox" className="size-6" checked={head.hasWhatsapp} onChange={(e) => setHead({ ...head, hasWhatsapp: e.target.checked })} />على هذا الرقم واتساب</label>
        <label className="flex min-h-12 items-center gap-3 font-semibold"><input type="checkbox" className="size-6" checked={head.prefersVoice} onChange={(e) => setHead({ ...head, prefersVoice: e.target.checked })} />لا يقرأ: يُبلَّغ بمكالمة</label>
      </section>

      <section className={section} aria-label="الأفراد">
        <h2 className="text-lg font-bold">الأفراد ({members.length + 1} مع رب الأسرة)</h2>
        {members.map((m, i) => {
          const patch = (p: Partial<Member>) => setMembers(members.map((x, j) => (j === i ? { ...x, ...p } : x)));
          return (
            <fieldset key={i} className="flex min-w-0 flex-col gap-3 rounded-xl border border-line p-3">
              <legend className="px-1 text-sm font-semibold text-muted">الفرد {i + 2}</legend>
              <Field label="الاسم" value={m.fullName} onChange={(e) => patch({ fullName: e.target.value })} />
              <div className="grid grid-cols-2 gap-3">
                <SelectField label="الصلة" value={m.relation} onChange={(e) => { const r = e.target.value as Member['relation']; patch({ relation: r, gender: GENDER[r] || m.gender }); }}>
                    {Object.entries(RELATIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </SelectField>
                <SelectField label="الجنس" value={m.gender} onChange={(e) => patch({ gender: e.target.value as 'M' | 'F' })}><option value="M">ذكر</option><option value="F">أنثى</option></SelectField>
              </div>
              <Field label="المواليد" type="date" value={m.birthDate} onChange={(e) => patch({ birthDate: e.target.value })} />
              <label className="flex min-h-12 items-center gap-3 font-semibold"><input type="checkbox" className="size-6" checked={m.isOrphan} onChange={(e) => patch({ isOrphan: e.target.checked })} />يتيم</label>
              <Button variant="danger" className="min-h-11 self-start text-base" onClick={() => setMembers(members.filter((_, j) => j !== i))}>احذف هذا الفرد</Button>
            </fieldset>
          );
        })}
        <Button variant="secondary" onClick={() => setMembers([...members, { fullName: '', relation: 'SON', gender: 'M', birthDate: '', isOrphan: false }])}>أضف فرداً</Button>
      </section>

      <section className={section} aria-label="السكن والحال">
        <h2 className="text-lg font-bold">السكن والحال</h2>
        <div role="group" aria-labelledby="reg-tags" className="flex flex-wrap gap-2"><span id="reg-tags" className="w-full font-semibold">الفئات</span>
          {Object.entries(TAGS).map(([k, v]) => {
            const on = tags.includes(k);
            return <button key={k} type="button" aria-pressed={on} onClick={() => setTags(on ? tags.filter((t) => t !== k) : [...tags, k])} className={`min-h-12 rounded-full border px-4 font-semibold ${on ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface'}`}>{v}</button>;
          })}
        </div>
        <Field label="المحلة" value={home.mahalla} onChange={(e) => setHome({ ...home, mahalla: e.target.value })} />
        <Field label="أقرب نقطة دالة" value={home.landmark} onChange={(e) => setHome({ ...home, landmark: e.target.value })} />
        <SelectField label="نوع العقار" value={home.housing} onChange={(e) => setHome({ ...home, housing: e.target.value as typeof home.housing })}><option value="">—</option><option value="OWNED">ملك</option><option value="RENTED">إيجار</option><option value="OTHER">أخرى</option></SelectField>
        <Field label="رقم البطاقة التموينية" inputMode="numeric" dir="ltr" value={home.ration} onChange={(e) => setHome({ ...home, ration: e.target.value })} />
        <Button variant="secondary" disabled={locating} onClick={locate}>{locating ? 'يُحدَّد الموقع…' : location ? `الموقع: ${location.lat}, ${location.lng}` : 'التقط موقع الدار'}</Button>
      </section>

      <section className={section} aria-label="الدخل والوكيل">
        <h2 className="text-lg font-bold">الدخل الشهري (دينار)</h2>
        {Object.entries(INCOMES).map(([k, v]) => <Field key={k} label={v} inputMode="numeric" dir="ltr" value={incomes[k] ?? ''} onChange={(e) => setIncomes({ ...incomes, [k]: e.target.value })} />)}
        <Field label="وكيل يستلم عنها (اختياري)" hint="لا يستلم إلا رب الأسرة أو وكيل مسجَّل." value={proxy} onChange={(e) => setProxy(e.target.value)} />
      </section>

      <section className={section} aria-label="الصور">
        <h2 className="text-lg font-bold">صور الوثائق (اختيارية)</h2>
        {photos.length > 0 && (
          <ul className="grid grid-cols-3 gap-2">
            {photos.map((p, i) => (
              <li key={p.url} className="relative">
                <img src={p.url} alt={PHOTO_KINDS[p.category]} className="aspect-square w-full rounded-lg object-cover" />
                <button type="button" aria-label={`احذف صورة ${PHOTO_KINDS[p.category]}`} onClick={() => setPhotos(photos.filter((_, j) => j !== i))} className="absolute end-1 top-1 grid size-9 place-items-center rounded-full bg-black/70 text-xl text-white">×</button>
                <span className="text-xs text-muted">{PHOTO_KINDS[p.category]} · {Math.round(p.bytes.length / 1024)} ك.ب</span>
              </li>
            ))}
          </ul>
        )}
        <SelectField label="ما الذي تصوّره؟" value={photoKind} onChange={(e) => setPhotoKind(e.target.value as keyof typeof PHOTO_KINDS)}>{Object.entries(PHOTO_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</SelectField>
        <input ref={photoInput} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="صورة وثيقة" onChange={(e) => void addPhoto(e.target.files?.[0])} />
        <Button variant="secondary" disabled={photos.length >= 8} onClick={() => photoInput.current?.click()}>صوّر</Button>
      </section>

      <Button disabled={busy} onClick={() => void save()}>{busy ? 'يُحفظ…' : 'احفظ على الجهاز'}</Button>
    </Screen>
  );
}
