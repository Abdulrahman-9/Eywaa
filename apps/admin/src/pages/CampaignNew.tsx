import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatNumber } from '../lib/format';
import { TAGS } from '../lib/labels';
import type { Point } from './Campaigns';
import type { Fund } from './Cashbox';
import type { Program } from './Programs';
import { CLASS_AR } from './Scoring';

interface Preview {
  unit: string; quantity: number; mahallas: string[]; rejected: { familyNo: string; reason: string }[];
  funnel: { eligible: number; available: number; filtered: number; afterExclude: number; capped: number; manual: number; final: number };
  families: { familyNo: string; headName: string; members: number; points: number | null; class: keyof typeof CLASS_AR | null; registeredAt: string; mahalla: string | null; quantity: number; manual: boolean }[];
}
type Order = 'POINTS' | 'OLDEST' | 'NEWEST' | 'MEMBERS' | 'FAMILY_NO';
export const ORDER_AR: Record<Order, string> = {
  POINTS: 'الأعلى نقاطاً أولاً', OLDEST: 'الأقدم تسجيلاً أولاً', NEWEST: 'الأحدث تسجيلاً أولاً', MEMBERS: 'الأكثر أفراداً أولاً', FAMILY_NO: 'برقم العائلة',
};

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(/\D/g, '')) || 0);
const chip = (on: boolean) => `inline-flex min-h-10 items-center rounded-full border px-3.5 text-sm font-semibold ${on ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface hover:bg-ground'}`;

/** تحضير حملة: البرنامج والمدة والنقاط، ثم اختيار العوائل بالتصفية والترتيب والسقف واليد، ومعاينة من يدخلها قبل الإنشاء. */
export function CampaignNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api<Program[]>('/programs') });
  const points = useQuery({ queryKey: ['points'], queryFn: () => api<Point[]>('/points') });
  const [form, setForm] = useState({ name: '', programId: '', fundId: '', startsOn: today(), endsOn: inDays(7), pointIds: [] as string[] });
  const [newPoint, setNewPoint] = useState('');
  const [manualOnly, setManualOnly] = useState(false);
  const [f, setF] = useState({ classes: [] as string[], minPoints: '', membersMin: '', membersMax: '', registeredFrom: '', registeredTo: '', tagsAny: [] as string[], mahallas: [] as string[], order: 'FAMILY_NO' as Order, limit: '', maxQuantity: '' });
  const [include, setInclude] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [addNo, setAddNo] = useState('');

  const active = programs.data?.filter((p) => p.active) ?? [];
  const program = active.find((p) => p.id === form.programId);
  const money = program?.kind === 'MONEY';
  const funds = useQuery({ queryKey: ['accounting'], queryFn: () => api<{ funds: Fund[] }>('/accounting/summary'), enabled: money, retry: false });
  const usable = funds.data?.funds.filter((x) => !x.programId || x.programId === form.programId) ?? [];

  const selection = useMemo(() => {
    const s: Record<string, unknown> = { order: f.order, include, exclude, manualOnly };
    if (f.classes.length) s.classes = f.classes;
    if (f.tagsAny.length) s.tagsAny = f.tagsAny;
    if (f.mahallas.length) s.mahallas = f.mahallas;
    for (const k of ['minPoints', 'membersMin', 'membersMax', 'limit', 'maxQuantity'] as const) { const v = num(f[k]); if (v !== undefined && (v > 0 || k === 'minPoints')) s[k] = v; }
    if (f.registeredFrom) s.registeredFrom = f.registeredFrom;
    if (f.registeredTo) s.registeredTo = f.registeredTo;
    return s;
  }, [f, include, exclude, manualOnly]);
  const [debounced, setDebounced] = useState(selection);
  useEffect(() => { const t = setTimeout(() => setDebounced(selection), 350); return () => clearTimeout(t); }, [selection]);
  const preview = useQuery({
    queryKey: ['campaign-preview', form.programId, JSON.stringify(debounced)],
    queryFn: () => api<Preview>('/campaigns/preview', { method: 'POST', body: { programId: form.programId, selection: debounced } }),
    enabled: !!form.programId, placeholderData: keepPreviousData, retry: false,
  });
  const p = form.programId ? preview.data : undefined;

  const addPoint = useMutation({
    mutationFn: () => api<Point>('/points', { method: 'POST', body: { name: newPoint.trim() } }),
    onSuccess: (pt) => { setNewPoint(''); setForm((x) => ({ ...x, pointIds: [...x.pointIds, pt.id] })); queryClient.invalidateQueries({ queryKey: ['points'] }); },
  });
  const create = useMutation({
    mutationFn: () => api<{ id: string }>('/campaigns', { method: 'POST', body: { ...form, fundId: money ? form.fundId : undefined, selection } }),
    onSuccess: (c) => { toast('أُنشئت مسودة الحملة'); queryClient.invalidateQueries({ queryKey: ['campaigns'] }); navigate(`/campaigns/${c.id}`); },
  });
  const toggle = (key: 'classes' | 'tagsAny' | 'mahallas', v: string) => setF((x) => ({ ...x, [key]: x[key].includes(v) ? x[key].filter((y) => y !== v) : [...x[key], v] }));
  const addManual = () => { const no = addNo.replace(/\D/g, ''); if (no.length >= 5 && !include.includes(no)) { setInclude([...include, no]); setExclude(exclude.filter((x) => x !== no)); } setAddNo(''); };
  const fundShort = money && p && form.fundId ? (usable.find((x) => x.id === form.fundId)?.available ?? 0) < p.quantity : false;
  const ready = !!form.programId && (!money || !!form.fundId) && form.name.trim().length >= 3 && form.pointIds.length > 0 && form.endsOn >= form.startsOn && !!p && p.funnel.final > 0 && p.rejected.length === 0;

  return (
    <>
      <PageHeader title="تحضير حملة توزيع" description="اختر البرنامج والمدة والنقاط، ثم من يدخل الحملة. لا يُحفظ شيء حتى تضغط «أنشئ المسودة»، والمسودة يعتمدها موظف غيرك."
        action={<Link to="/campaigns" className="inline-flex min-h-11 items-center rounded-lg border border-line-strong bg-surface px-4 font-semibold hover:bg-ground">رجوع إلى الحملات</Link>} />
      {(create.error || addPoint.error || preview.error) && <Alert>{(create.error ?? addPoint.error ?? preview.error)!.message}</Alert>}

      <Card className="flex flex-col gap-4">
        <h2 className="text-lg font-bold">1. البرنامج والمدة والنقاط</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
          <Field label="البرنامج">
            {(id) => (
              <Select id={id} value={form.programId} onChange={(e) => { setForm({ ...form, programId: e.target.value, fundId: '' }); setInclude([]); setExclude([]); }}>
                <option value="">اختر برنامجاً</option>
                {active.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="اسم الحملة">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="مثال: لحوم الأضاحي، عيد الأضحى 2027" />}</Field>
          <Field label="تبدأ">{(id) => <Input id={id} type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} />}</Field>
          <Field label="تنتهي">{(id) => <Input id={id} type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} />}</Field>
        </div>
        {program && <p className="rounded-lg bg-brand-soft px-3 py-2">يستحقه الآن <strong>{formatNumber(program.eligibleFamilies)}</strong> عائلة، وحاجتها {formatNumber(program.eligibleQuantity)} {program.unit}. من استلم قريباً يُستثنى.</p>}
        {money && (
          <div className="max-w-md">
            <Field label="تُصرف من صندوق" hint="يُحجز مبلغ الحملة من المتاح فيه عند الاعتماد">
              {(id) => <Select id={id} value={form.fundId} onChange={(e) => setForm({ ...form, fundId: e.target.value })}><option value="">اختر الصندوق</option>{usable.map((x) => <option key={x.id} value={x.id}>{x.name} (المتاح {formatNumber(x.available)})</option>)}</Select>}
            </Field>
          </div>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">نقاط التوزيع (تُقسَّم العوائل عليها بالتساوي)</legend>
          <div className="flex flex-wrap gap-2">
            {points.data?.filter((x) => x.active).map((x) => (
              <label key={x.id} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-3.5">
                <input type="checkbox" className="size-[18px] accent-brand" checked={form.pointIds.includes(x.id)}
                  onChange={(e) => setForm({ ...form, pointIds: e.target.checked ? [...form.pointIds, x.id] : form.pointIds.filter((y) => y !== x.id) })} />{x.name}
              </label>
            ))}
          </div>
          <div className="flex max-w-md flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1"><Field label="نقطة جديدة">{(id) => <Input id={id} value={newPoint} onChange={(e) => setNewPoint(e.target.value)} />}</Field></div>
            <Button variant="secondary" disabled={newPoint.trim().length < 2 || addPoint.isPending} onClick={() => addPoint.mutate()}>أضف النقطة</Button>
          </div>
        </fieldset>
      </Card>

      {program && (
        <Card className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="min-w-0 flex-1 text-lg font-bold">2. من يدخل الحملة؟</h2>
            <div role="group" aria-label="طريقة الاختيار" className="flex gap-2">
              <button type="button" aria-pressed={!manualOnly} className={chip(!manualOnly)} onClick={() => setManualOnly(false)}>آلياً بالتصفية</button>
              <button type="button" aria-pressed={manualOnly} className={chip(manualOnly)} onClick={() => setManualOnly(true)}>يدوياً بالأرقام</button>
            </div>
          </div>
          <p className="text-sm text-muted">{manualOnly ? 'لا تدخل الحملةَ إلا العوائل التي تضيفها برقمها. ومن لا يستحق البرنامج لا يدخل ولو أضفتَه.' : 'يبدأ الاختيار بكل من يستحق البرنامج، وكل شرط تضعه يضيّق. ما تتركه فارغاً لا يُشترط.'}</p>

          {!manualOnly && (
            <>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
                <Field label="أقل نقاط">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={f.minPoints} onChange={(e) => setF({ ...f, minPoints: e.target.value })} />}</Field>
                <Field label="أقل عدد أفراد">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={f.membersMin} onChange={(e) => setF({ ...f, membersMin: e.target.value })} />}</Field>
                <Field label="أكثر عدد أفراد">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={f.membersMax} onChange={(e) => setF({ ...f, membersMax: e.target.value })} />}</Field>
                <Field label="سُجّلت من تاريخ">{(id) => <Input id={id} type="date" value={f.registeredFrom} onChange={(e) => setF({ ...f, registeredFrom: e.target.value })} />}</Field>
                <Field label="سُجّلت حتى تاريخ">{(id) => <Input id={id} type="date" value={f.registeredTo} onChange={(e) => setF({ ...f, registeredTo: e.target.value })} />}</Field>
              </div>
              <div role="group" aria-label="الفئة بالنقاط" className="flex flex-wrap items-center gap-2">
                <span className="w-28 text-sm font-medium">الفئة بالنقاط</span>
                {Object.entries(CLASS_AR).map(([k, v]) => <button key={k} type="button" aria-pressed={f.classes.includes(k)} className={chip(f.classes.includes(k))} onClick={() => toggle('classes', k)}>الفئة {v}</button>)}
              </div>
              <div role="group" aria-label="صنف العائلة" className="flex flex-wrap items-center gap-2">
                <span className="w-28 text-sm font-medium">صنف العائلة</span>
                {Object.entries(TAGS).map(([k, v]) => <button key={k} type="button" aria-pressed={f.tagsAny.includes(k)} className={chip(f.tagsAny.includes(k))} onClick={() => toggle('tagsAny', k)}>{v}</button>)}
              </div>
              {(p?.mahallas.length ?? 0) > 0 && (
                <div role="group" aria-label="المحلة" className="flex flex-wrap items-center gap-2">
                  <span className="w-28 text-sm font-medium">المحلة</span>
                  {p!.mahallas.map((m) => <button key={m} type="button" aria-pressed={f.mahallas.includes(m)} className={chip(f.mahallas.includes(m))} onClick={() => toggle('mahallas', m)}>{m}</button>)}
                </div>
              )}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3 rounded-lg bg-ground p-3">
                <Field label="الأَولى فالأَولى" hint="حين يضيق السقف يدخل من تقدّم في هذا الترتيب.">
                  {(id) => <Select id={id} value={f.order} onChange={(e) => setF({ ...f, order: e.target.value as Order })}>{Object.entries(ORDER_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
                </Field>
                <Field label="أقصى عدد العوائل" hint="اتركه فارغاً إن لم يكن سقف.">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} />}</Field>
                <Field label={`أقصى المقدار (${program.unit})`} hint="ما عندك في المخزن أو الصندوق.">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={f.maxQuantity} onChange={(e) => setF({ ...f, maxQuantity: e.target.value })} />}</Field>
              </div>
            </>
          )}

          <div className="flex max-w-xl flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1"><Field label="أضف عائلة برقمها" hint={manualOnly ? undefined : 'تدخل فوق السقف والتصفية، ما دامت تستحق البرنامج.'}>{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={addNo} onChange={(e) => setAddNo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }} />}</Field></div>
            <Button variant="secondary" disabled={addNo.replace(/\D/g, '').length < 5} onClick={addManual}>أضف العائلة</Button>
          </div>
          {p && p.rejected.length > 0 && (
            <Alert>
              <strong>لا تدخل الحملةَ:</strong>
              <ul className="mt-1 flex flex-col gap-1">{p.rejected.map((r) => <li key={r.familyNo} className="flex flex-wrap items-center gap-2"><span className="tabular-nums">{r.familyNo}</span><span>{r.reason}</span><button type="button" className="underline" onClick={() => setInclude(include.filter((x) => x !== r.familyNo))}>أزلها</button></li>)}</ul>
            </Alert>
          )}
          {exclude.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">مستثناة باليد:</span>
              {exclude.map((no) => <button key={no} type="button" className="rounded-full border border-line-strong px-3 py-1 tabular-nums hover:bg-ground" onClick={() => setExclude(exclude.filter((x) => x !== no))}>{no} · أرجِعها</button>)}
            </div>
          )}
        </Card>
      )}

      {program && p && (
        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-bold">3. المعاينة</h2>
          <ol aria-label="خطوات الاختيار" className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
            {([['يستحق البرنامج', p.funnel.eligible], ['المتاح الآن', p.funnel.available], ...(manualOnly ? [] : [['بعد التصفية', p.funnel.filtered], ['بعد السقف', p.funnel.capped]]), ['أُضيف باليد', p.funnel.manual]] as [string, number][]).map(([label, n]) => (
              <li key={label} className="rounded-lg border border-line px-3 py-2"><div className="text-sm text-muted">{label}</div><div className="text-xl font-bold tabular-nums">{formatNumber(n)}</div></li>
            ))}
            <li className="rounded-lg border border-brand bg-brand-soft px-3 py-2"><div className="text-sm text-brand-strong">يدخل الحملة</div><div className="text-xl font-bold tabular-nums" data-testid="final">{formatNumber(p.funnel.final)}</div></li>
          </ol>
          <p className="text-lg"><strong>{formatNumber(p.funnel.final)}</strong> عائلة، حاجتها <strong>{formatNumber(p.quantity)} {p.unit}</strong>.{p.funnel.eligible > p.funnel.available && ` (${formatNumber(p.funnel.eligible - p.funnel.available)} مستحقة استُثنيت: استلمت قريباً أو في حملة قائمة.)`}</p>
          {fundShort && <Alert tone="warn">المتاح في الصندوق لا يكفي هذا المبلغ: لن تُعتمد الحملة حتى يكفي. ضع سقفاً للمقدار أو اختر صندوقاً آخر.</Alert>}
          {p.funnel.final === 0 && <Alert tone="warn">لا عائلة تطابق هذا الاختيار. وسّع التصفية أو أضف باليد.</Alert>}
          {p.families.length > 0 && (
            <div className="max-h-[28rem] overflow-auto rounded-lg border border-line">
              <table className="w-full min-w-[46rem] border-collapse text-sm">
                <thead className="sticky top-0 bg-surface"><tr className="text-muted">{['#', 'رقم العائلة', 'رب الأسرة', 'الأفراد', 'النقاط', 'سُجّلت', 'المحلة', `المقدار (${p.unit})`, ''].map((h, i) => <th key={i} scope="col" className="border-b border-line px-3 py-2 text-start font-medium">{h || <span className="sr-only">استثناء</span>}</th>)}</tr></thead>
                <tbody>
                  {p.families.map((x, i) => (
                    <tr key={x.familyNo} className="border-b border-line last:border-0">
                      <td className="px-3 py-2 tabular-nums text-muted">{i + 1}</td>
                      <td className="px-3 py-2 font-semibold tabular-nums">{x.familyNo}</td>
                      <td className="px-3 py-2">{x.headName}{x.manual && <> <Badge tone="info">باليد</Badge></>}</td>
                      <td className="px-3 py-2 tabular-nums">{x.members}</td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{x.points ?? '—'}{x.class && <span className="text-muted"> · {CLASS_AR[x.class]}</span>}</td>
                      <td className="whitespace-nowrap px-3 py-2">{formatDate(x.registeredAt)}</td>
                      <td className="px-3 py-2">{x.mahalla ?? '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{formatNumber(x.quantity)}</td>
                      <td className="px-3 py-1 text-end"><button type="button" className="min-h-9 rounded-lg border border-line-strong px-3 font-semibold hover:bg-ground" onClick={() => (x.manual ? setInclude(include.filter((n) => n !== x.familyNo)) : setExclude([...exclude, x.familyNo]))}>استثنِ</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {p.funnel.final > p.families.length && <p className="text-sm text-muted">يُعرض أول {p.families.length} من {formatNumber(p.funnel.final)}. الباقي يدخل الحملة بالترتيب نفسه.</p>}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Link to="/campaigns" className="inline-flex min-h-11 items-center rounded-lg border border-line-strong px-4 font-semibold hover:bg-ground">إلغاء</Link>
            <Button disabled={!ready || create.isPending || preview.isFetching} onClick={() => create.mutate()}>{create.isPending ? 'جارٍ الإنشاء…' : 'أنشئ المسودة'}</Button>
          </div>
        </Card>
      )}
    </>
  );
}
