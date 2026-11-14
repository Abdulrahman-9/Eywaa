import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CalendarDays, CheckCircle2, MapPin, Plus, Sparkles, Target, UserPlus, Users, Wand2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Chip, CountUp, Field, Input, Segmented, Select, Skeleton, Stepper, type StepInfo } from '../components/ui';
import { api } from '../lib/api';
import { CLASS_LETTER, ORDER_AR, PICKED_AR, describeSelection, type Order, type Selection } from '../lib/campaign';
import { formatDate, formatNumber, digits } from '../lib/format';
import { TAGS } from '../lib/labels';
import type { Point } from './Campaigns';
import type { Fund } from './Cashbox';
import type { Program } from './Programs';

interface Row { familyNo: string; headName: string; members: number; points: number | null; class: keyof typeof CLASS_LETTER | null; registeredAt: string; mahalla: string | null; quantity: number; benefits: number; lastBenefitAt: string | null; pickedBy: 'RULE' | 'NOMINATED' | 'MANUAL' }
interface Preview {
  unit: string; quantity: number; mahallas: string[]; rejected: { familyNo: string; reason: string }[];
  funnel: { eligible: number; available: number; filtered: number; afterExclude: number; capped: number; nominated: number; manual: number; final: number };
  gap: number; relaxations: { label: string; patch: Record<string, unknown>; gain: number }[]; nominees: (Row & { why: string })[]; families: Row[];
}
interface CampaignDetail {
  id: string; name: string; status: string; programId: string; fundId: string | null; startsOn: string; endsOn: string; selection: Selection; points: { id: string }[];
}

const STEPS: StepInfo[] = [
  { slug: 'basics', title: 'الأساس', hint: 'البرنامج والمدة والعدد' },
  { slug: 'rules', title: 'من يستفيد', hint: 'القواعد والأولوية' },
  { slug: 'families', title: 'العوائل', hint: 'المعاينة وإكمال العدد' },
  { slug: 'points', title: 'نقاط التوزيع', hint: 'النقاط والمتعهدون' },
  { slug: 'review', title: 'المراجعة', hint: 'ثم الحفظ' },
];

/** كل ما يكتبه المدير في الصفحات الخمس. يُحفظ في التبويب، فلا يضيع بالتنقل بين الصفحات ولا بتحديث الصفحة. */
interface Draft {
  name: string; programId: string; fundId: string; startsOn: string; endsOn: string; pointIds: string[]; manualOnly: boolean;
  limit: string; maxQuantity: string; order: Order; classes: string[]; minPoints: string; membersMin: string; membersMax: string; registeredFrom: string; registeredTo: string;
  tagsAny: string[]; mahallas: string[]; benefitCount: string; benefitMonths: string; sinceDays: string; scope: 'PROGRAM' | 'ALL';
  include: string[]; nominated: string[]; exclude: string[];
}
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const blank = (): Draft => ({
  name: '', programId: '', fundId: '', startsOn: today(), endsOn: inDays(7), pointIds: [], manualOnly: false, limit: '', maxQuantity: '', order: 'FAMILY_NO',
  classes: [], minPoints: '', membersMin: '', membersMax: '', registeredFrom: '', registeredTo: '', tagsAny: [], mahallas: [], benefitCount: '', benefitMonths: '12', sinceDays: '', scope: 'PROGRAM',
  include: [], nominated: [], exclude: [],
});
const str = (v: number | undefined) => (v === undefined ? '' : String(v));
/** من حملة محفوظة إلى حقول الصفحات: به يفتح التعديل الصفحات نفسها بما فيها. */
const fromCampaign = (c: CampaignDetail): Draft => {
  const s = c.selection ?? {};
  return {
    ...blank(), name: c.name, programId: c.programId, fundId: c.fundId ?? '', startsOn: c.startsOn.slice(0, 10), endsOn: c.endsOn.slice(0, 10), pointIds: c.points.map((p) => p.id),
    manualOnly: !!s.manualOnly, limit: str(s.limit), maxQuantity: str(s.maxQuantity), order: s.order ?? 'FAMILY_NO', classes: s.classes ?? [], minPoints: str(s.minPoints),
    membersMin: str(s.membersMin), membersMax: str(s.membersMax), registeredFrom: s.registeredFrom ?? '', registeredTo: s.registeredTo ?? '', tagsAny: s.tagsAny ?? [], mahallas: s.mahallas ?? [],
    benefitCount: s.maxBenefits ? String(s.maxBenefits.count) : '', benefitMonths: String(s.maxBenefits?.months ?? 12), sinceDays: s.notSinceDays ? String(s.notSinceDays.days) : '',
    scope: s.maxBenefits?.scope ?? s.notSinceDays?.scope ?? 'PROGRAM', include: s.include ?? [], nominated: s.nominated ?? [], exclude: s.exclude ?? [],
  };
};
const num = (v: string) => (v.trim() === '' ? undefined : Number(digits(v)) || 0);
const toSelection = (d: Draft): Selection => {
  const s: Selection = { order: d.order, include: d.include, nominated: d.nominated, exclude: d.exclude, manualOnly: d.manualOnly };
  if (d.classes.length) s.classes = d.classes;
  if (d.tagsAny.length) s.tagsAny = d.tagsAny;
  if (d.mahallas.length) s.mahallas = d.mahallas;
  for (const k of ['minPoints', 'membersMin', 'membersMax', 'limit', 'maxQuantity'] as const) { const v = num(d[k]); if (v !== undefined && (v > 0 || k === 'minPoints')) s[k] = v; }
  if (d.registeredFrom) s.registeredFrom = d.registeredFrom;
  if (d.registeredTo) s.registeredTo = d.registeredTo;
  if (d.benefitCount.trim() !== '') s.maxBenefits = { count: num(d.benefitCount) ?? 0, months: Math.max(1, num(d.benefitMonths) ?? 12), scope: d.scope };
  if ((num(d.sinceDays) ?? 0) > 0) s.notSinceDays = { days: num(d.sinceDays)!, scope: d.scope };
  return s;
};
/**
 * المسودة المحفوظة في المتصفح تحمل بصمة حال الحملة في الخادم يوم بدأ التعديل. فإن تغيّرت الحملة بعدها
 * (أُضيفت عائلة أو حُذفت من صفحة الحملة) لم تُستعمل: لو استُعملت لأعاد الحفظُ اللقطةَ القديمة ومحا ما عُدّل باليد.
 */
const read = (key: string, basis: string): Draft | null => {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { basis?: string; d?: Partial<Draft> };
    return stored.d && stored.basis === basis ? { ...blank(), ...stored.d } : null;
  } catch { return null; }
};

/** تحضير حملة أو تعديل مسودتها: خمس صفحات يُتنقَّل بينها دون أن يضيع ما كُتب. */
export function CampaignWizard() {
  const { id } = useParams();
  // تُجلب الحملة من الخادم عند كل دخول إلى التعديل (لا من ذاكرة المتصفح)، ولا يُعاد جلبها والمعالج مفتوح.
  const detail = useQuery({ queryKey: ['campaign', id, 'edit'], queryFn: () => api<CampaignDetail>(`/campaigns/${id}`), enabled: !!id, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false });
  if (id && detail.isPending) return <Skeleton className="h-64 w-full" />;
  if (id && detail.error) return <Alert>{detail.error.message}</Alert>;
  if (id && detail.data!.status !== 'DRAFT') {
    return <Alert tone="warn">لا تُعدَّل الحملة إلا وهي مسودة. <Link to={`/campaigns/${id}`} className="font-bold underline">ارجع إلى الحملة</Link></Alert>;
  }
  return <Wizard key={id ?? 'new'} campaign={detail.data} />;
}

function Wizard({ campaign }: { campaign?: CampaignDetail }) {
  const { step = 'basics' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = !!campaign;
  const base = editing ? `/campaigns/${campaign.id}/edit` : '/campaigns/new';
  const storageKey = `eywaa.campaign.${campaign?.id ?? 'new'}`;
  const [basis] = useState(() => (campaign ? JSON.stringify(fromCampaign(campaign)) : 'new'));
  const [d, setD] = useState<Draft>(() => read(storageKey, basis) ?? (campaign ? fromCampaign(campaign) : blank()));
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const saved = useRef(false);
  useEffect(() => { if (!saved.current) { try { sessionStorage.setItem(storageKey, JSON.stringify({ basis, d })); } catch { /* يعمل بلا حفظ */ } } }, [d, storageKey, basis]);

  const [newPoint, setNewPoint] = useState('');
  const [addNo, setAddNo] = useState('');
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api<Program[]>('/programs') });
  const points = useQuery({ queryKey: ['points'], queryFn: () => api<Point[]>('/points') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<{ id: string; fullName: string; pointId: string | null }[]>('/agents') });
  const active = programs.data?.filter((p) => p.active) ?? [];
  const program = active.find((p) => p.id === d.programId);
  const money = program?.kind === 'MONEY';
  const funds = useQuery({ queryKey: ['accounting'], queryFn: () => api<{ funds: Fund[] }>('/accounting/summary'), enabled: money, retry: false });
  const usable = funds.data?.funds.filter((x) => !x.programId || x.programId === d.programId) ?? [];

  // الاختيار يُعاد بناؤه حين يتغيّر مضمونه لا حين يتغيّر أي حقل (كالاسم أو النقاط): فلا تُعاد المعاينة بلا موجب.
  const selectionJson = JSON.stringify(toSelection(d));
  const selection = useMemo(() => JSON.parse(selectionJson) as Selection, [selectionJson]);
  const [debounced, setDebounced] = useState(selection);
  useEffect(() => { const t = setTimeout(() => setDebounced(selection), 300); return () => clearTimeout(t); }, [selection]);
  const preview = useQuery({
    queryKey: ['campaign-preview', d.programId, campaign?.id, JSON.stringify(debounced)],
    queryFn: () => api<Preview>('/campaigns/preview', { method: 'POST', body: { programId: d.programId, selection: debounced, campaignId: campaign?.id } }),
    enabled: !!d.programId, placeholderData: keepPreviousData, retry: false,
  });
  const p = d.programId ? preview.data : undefined;
  const settling = preview.isFetching || debounced !== selection;

  const addPoint = useMutation({
    mutationFn: () => api<Point>('/points', { method: 'POST', body: { name: newPoint.trim() } }),
    onSuccess: (pt) => { setNewPoint(''); setD((x) => ({ ...x, pointIds: [...x.pointIds, pt.id] })); queryClient.invalidateQueries({ queryKey: ['points'] }); },
  });
  /** المتعهد يدخل الحملة بنقطته. إن لم تكن له نقطة أُنشئت باسمه عند أول اختيار. */
  const pickAgent = useMutation({
    mutationFn: async (a: { id: string; pointId: string | null }) => a.pointId ?? (await api<Point>(`/agents/${a.id}/point`, { method: 'POST' })).id,
    onSuccess: (pointId) => { setD((x) => ({ ...x, pointIds: x.pointIds.includes(pointId) ? x.pointIds.filter((y) => y !== pointId) : [...x.pointIds, pointId] })); queryClient.invalidateQueries({ queryKey: ['agents'] }); queryClient.invalidateQueries({ queryKey: ['points'] }); },
  });
  const save = useMutation({
    mutationFn: () => api<{ id: string }>(editing ? `/campaigns/${campaign.id}` : '/campaigns', {
      method: editing ? 'PUT' : 'POST',
      body: { name: d.name.trim(), programId: d.programId, startsOn: d.startsOn, endsOn: d.endsOn, pointIds: d.pointIds, fundId: money ? d.fundId : undefined, selection },
    }),
    onSuccess: (c) => {
      saved.current = true;
      try { sessionStorage.removeItem(storageKey); } catch { /* لا شيء */ }
      toast(editing ? 'حُفظ تعديل المسودة' : 'أُنشئت مسودة الحملة');
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign'] });
      navigate(`/campaigns/${c.id}`);
    },
  });

  const toggle = (key: 'classes' | 'tagsAny' | 'mahallas', v: string) => setD((x) => ({ ...x, [key]: x[key].includes(v) ? x[key].filter((y) => y !== v) : [...x[key], v] }));
  /** يطبّق اقتراح تقريب على القواعد نفسها: ما يتغيّر يراه المدير في صفحة القواعد. */
  const relax = (label: string, patch: Record<string, unknown>) => {
    setD((x) => {
      const n = { ...x };
      for (const [k, v] of Object.entries(patch)) {
        // null: الاقتراح يمسح الشرط كله.
        if (k === 'minPoints' || k === 'membersMin' || k === 'membersMax') n[k] = v == null ? '' : String(v);
        else if (k === 'classes' || k === 'mahallas' || k === 'tagsAny') n[k] = (v as string[] | null | undefined) ?? [];
        else if (k === 'registeredFrom' || k === 'registeredTo') n[k] = (v as string | null | undefined) ?? '';
        else if (k === 'maxBenefits') n.benefitCount = v == null ? '' : String((v as { count: number }).count);
        else if (k === 'notSinceDays') n.sinceDays = v == null ? '' : String((v as { days: number }).days);
      }
      return n;
    });
    toast(`عُدّلت القاعدة: ${label}`, 'info');
  };
  const addManual = () => { const no = digits(addNo); if (no.length >= 5 && !d.include.includes(no)) set({ include: [...d.include, no], exclude: d.exclude.filter((x) => x !== no) }); setAddNo(''); };
  const dropRow = (x: Row) => (x.pickedBy === 'MANUAL' ? set({ include: d.include.filter((n) => n !== x.familyNo) }) : x.pickedBy === 'NOMINATED' ? set({ nominated: d.nominated.filter((n) => n !== x.familyNo) }) : set({ exclude: [...d.exclude, x.familyNo] }));

  // ما يلزم كل صفحة لتُتجاوز. لا يُتقدَّم إلى صفحة قبل أن تصحّ التي قبلها.
  const problems: (string | null)[] = [
    !d.programId ? 'اختر البرنامج' : d.name.trim().length < 3 ? 'اكتب اسم الحملة' : d.endsOn < d.startsOn ? 'تاريخ النهاية قبل البداية' : money && !d.fundId ? 'اختر الصندوق' : null,
    null,
    !p ? 'تُحسب المعاينة…' : p.rejected.length ? 'في المضافة باليد عائلة لا تدخل الحملة' : p.funnel.final === 0 ? 'لا عائلة في الحملة' : null,
    d.pointIds.length === 0 ? 'اختر نقطة توزيع أو متعهداً' : null,
    null,
  ];
  const firstBad = problems.findIndex((x) => x !== null);
  const reachable = firstBad === -1 ? STEPS.length - 1 : firstBad;
  const index = Math.max(0, STEPS.findIndex((s) => s.slug === step));
  const direction = useRef(1);
  const go = (i: number) => { direction.current = i > index ? 1 : -1; navigate(`${base}/${STEPS[i].slug}`); window.scrollTo({ top: 0 }); };
  if (STEPS.every((s) => s.slug !== step) || index > reachable) return <Navigate to={`${base}/${STEPS[Math.min(index, reachable)].slug}`} replace />;

  const fundShort = money && p && d.fundId ? (usable.find((x) => x.id === d.fundId)?.available ?? 0) < p.quantity : false;
  const pointName = (pid: string) => { const pt = points.data?.find((x) => x.id === pid); return pt?.agentId ? `المتعهد ${pt.agentName}` : pt?.name ?? '…'; };
  const error = save.error ?? addPoint.error ?? preview.error;

  return (
    <>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{editing ? `تعديل مسودة: ${campaign.name}` : 'تحضير حملة توزيع'}</h1>
          <p className="text-muted">خمس صفحات. ما تكتبه محفوظ وأنت تتنقل بينها، ولا يُحفظ في النظام حتى تضغط «{editing ? 'احفظ التعديل' : 'أنشئ المسودة'}» في آخرها.</p>
        </div>
        <Link to={editing ? `/campaigns/${campaign.id}` : '/campaigns'} className="inline-flex min-h-11 items-center rounded-lg border border-line-strong bg-surface px-4 font-semibold transition-colors hover:bg-ground">{editing ? 'رجوع إلى الحملة' : 'رجوع إلى الحملات'}</Link>
      </div>

      <Card className="px-3 py-4"><Stepper steps={STEPS} current={index} reachable={reachable} onGo={go} /></Card>
      {error && <Alert>{error.message}</Alert>}

      <AnimatePresence mode="wait" initial={false} custom={direction.current}>
        <motion.div key={step} custom={direction.current} className="flex flex-col gap-6"
          initial={{ opacity: 0, x: -28 * direction.current }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 28 * direction.current, transition: { duration: 0.1 } }} transition={{ duration: 0.2, ease: 'easeOut' }}>

          {step === 'basics' && (
            <>
              <Card className="flex flex-col gap-4">
                <h2 className="flex items-center gap-2 text-lg font-bold"><CalendarDays aria-hidden="true" className="size-5 text-brand" />البرنامج والمدة</h2>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
                  <Field label="البرنامج">
                    {(id) => (
                      <Select id={id} value={d.programId} onChange={(e) => set({ programId: e.target.value, fundId: '', include: [], nominated: [], exclude: [] })}>
                        <option value="">اختر برنامجاً</option>
                        {active.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </Select>
                    )}
                  </Field>
                  <Field label="اسم الحملة">{(id) => <Input id={id} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="مثال: لحوم الأضاحي، عيد الأضحى 2027" />}</Field>
                  <Field label="تبدأ">{(id) => <Input id={id} type="date" value={d.startsOn} onChange={(e) => set({ startsOn: e.target.value })} />}</Field>
                  <Field label="تنتهي">{(id) => <Input id={id} type="date" value={d.endsOn} onChange={(e) => set({ endsOn: e.target.value })} />}</Field>
                </div>
                {programs.isSuccess && active.length === 0 && <Alert tone="warn">لا برنامج بعد. أنشئ برنامجاً من <Link to="/programs" className="font-bold underline">البرامج</Link> (وفيها قوالب جاهزة)، ثم عُد.</Alert>}
                {program && <p className="rounded-lg bg-brand-soft px-3 py-2">يستحقه الآن <strong>{formatNumber(program.eligibleFamilies)}</strong> عائلة، وحاجتها {formatNumber(program.eligibleQuantity)} {program.unit}. من استلم قريباً يُستثنى.</p>}
                {money && (
                  <div className="max-w-md">
                    <Field label="تُصرف من صندوق" hint="يُحجز مبلغ الحملة من المتاح فيه عند الاعتماد">
                      {(id) => <Select id={id} value={d.fundId} onChange={(e) => set({ fundId: e.target.value })}><option value="">اختر الصندوق</option>{usable.map((x) => <option key={x.id} value={x.id}>{x.name} (المتاح {formatNumber(x.available)})</option>)}</Select>}
                    </Field>
                  </div>
                )}
              </Card>
              <Card className="flex flex-col gap-4 border-brand/40 bg-gradient-to-bl from-brand-soft/70 to-surface">
                <h2 className="flex items-center gap-2 text-lg font-bold"><Target aria-hidden="true" className="size-5 text-brand" />العدد المستهدف</h2>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
                  <Field label="كم عائلة تستهدف؟" hint="ابدأ بالعدد. إن نقصت القواعد عنه اقترح النظام كيف يُكمَل، وإن زادت دخل الأَولى. اتركه فارغاً لكل من يطابق.">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={d.limit} onChange={(e) => set({ limit: e.target.value })} />}</Field>
                  <Field label={`أقصى المقدار${program ? ` (${program.unit})` : ''}`} hint="ما عندك في المخزن أو الصندوق. اتركه فارغاً إن لم يكن سقف.">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={d.maxQuantity} onChange={(e) => set({ maxQuantity: e.target.value })} />}</Field>
                </div>
              </Card>
            </>
          )}

          {step === 'rules' && program && (
            <Card className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="flex min-w-0 flex-1 items-center gap-2 text-lg font-bold"><Users aria-hidden="true" className="size-5 text-brand" />من يدخل الحملة؟</h2>
                <Segmented label="طريقة الاختيار" value={d.manualOnly ? 'manual' : 'auto'} onChange={(v) => set({ manualOnly: v === 'manual' })} options={[['auto', 'آلياً بالقواعد'], ['manual', 'يدوياً بالأرقام']]} />
              </div>
              {d.manualOnly ? (
                <Alert tone="warn">لا تدخل الحملةَ إلا العوائل التي تضيفها برقمها في الصفحة التالية. ومن لا يستحق البرنامج لا يدخل ولو أضفتَه.</Alert>
              ) : (
                <>
                  <p className="text-sm text-muted">يبدأ الاختيار بكل من يستحق البرنامج، وكل قاعدة تضعها تضيّق. ما تتركه فارغاً لا يُشترط.</p>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
                    <Field label="أقل نقاط">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={d.minPoints} onChange={(e) => set({ minPoints: e.target.value })} />}</Field>
                    <Field label="أقل عدد أفراد">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={d.membersMin} onChange={(e) => set({ membersMin: e.target.value })} />}</Field>
                    <Field label="أكثر عدد أفراد">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={d.membersMax} onChange={(e) => set({ membersMax: e.target.value })} />}</Field>
                    <Field label="سُجّلت من تاريخ">{(id) => <Input id={id} type="date" value={d.registeredFrom} onChange={(e) => set({ registeredFrom: e.target.value })} />}</Field>
                    <Field label="سُجّلت حتى تاريخ">{(id) => <Input id={id} type="date" value={d.registeredTo} onChange={(e) => set({ registeredTo: e.target.value })} />}</Field>
                  </div>
                  <div role="group" aria-label="الفئة بالنقاط" className="flex flex-wrap items-center gap-2">
                    <span className="w-28 text-sm font-medium">الفئة بالنقاط</span>
                    {Object.entries(CLASS_LETTER).map(([k, v]) => <Chip key={k} on={d.classes.includes(k)} onClick={() => toggle('classes', k)}>الفئة {v}</Chip>)}
                  </div>
                  <div role="group" aria-label="حالة العائلة" className="flex flex-wrap items-center gap-2">
                    <span className="w-28 text-sm font-medium">حالة العائلة</span>
                    {Object.entries(TAGS).map(([k, v]) => <Chip key={k} on={d.tagsAny.includes(k)} onClick={() => toggle('tagsAny', k)}>{v}</Chip>)}
                  </div>
                  {(p?.mahallas.length ?? 0) > 0 && (
                    <div role="group" aria-label="المنطقة" className="flex flex-wrap items-center gap-2">
                      <span className="w-28 text-sm font-medium">المنطقة (المحلة)</span>
                      {p!.mahallas.map((m) => <Chip key={m} on={d.mahallas.includes(m)} onClick={() => toggle('mahallas', m)}>{m}</Chip>)}
                    </div>
                  )}
                  <div className="flex flex-col gap-2 rounded-xl bg-ground p-4">
                    <span className="text-sm font-semibold">مرات الاستفادة</span>
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
                      <Field label="استلمت على الأكثر (مرة)" hint="0: لم تستفد قط في المدة.">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={d.benefitCount} onChange={(e) => set({ benefitCount: e.target.value })} />}</Field>
                      <Field label="في آخر (شهراً)">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={d.benefitMonths} onChange={(e) => set({ benefitMonths: e.target.value })} />}</Field>
                      <Field label="لم تستلم منذ (يوماً)">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={d.sinceDays} onChange={(e) => set({ sinceDays: e.target.value })} />}</Field>
                      <Field label="تُحسب من">{(id) => <Select id={id} value={d.scope} onChange={(e) => set({ scope: e.target.value as 'PROGRAM' | 'ALL' })}><option value="PROGRAM">هذا البرنامج وحده</option><option value="ALL">كل البرامج</option></Select>}</Field>
                    </div>
                  </div>
                  <div className="max-w-sm">
                    <Field label="الأَولى فالأَولى" hint="من يتقدّم حين تزيد القواعد عن العدد المستهدف.">
                      {(id) => <Select id={id} value={d.order} onChange={(e) => set({ order: e.target.value as Order })}>{Object.entries(ORDER_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
                    </Field>
                  </div>
                  {p && (
                    <div aria-live="polite" className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3">
                      <span className="text-2xl font-bold text-brand-strong"><CountUp value={p.funnel.filtered} /></span>
                      <span>عائلة تطابق القواعد، من {formatNumber(p.funnel.available)} متاحة.</span>
                      {p.gap > 0 && <Badge tone="warn">ينقص {formatNumber(p.gap)} عن المستهدف: يُكمَل في الصفحة التالية</Badge>}
                      {d.limit && p.funnel.filtered > (num(d.limit) ?? 0) && <Badge tone="info">تزيد عن المستهدف: يدخل الأَولى</Badge>}
                    </div>
                  )}
                </>
              )}
            </Card>
          )}

          {step === 'families' && program && p && (
            <>
              <Card className="flex flex-col gap-4">
                <h2 className="flex items-center gap-2 text-lg font-bold"><Users aria-hidden="true" className="size-5 text-brand" />من يدخل الحملة</h2>
                <ol aria-label="خطوات الاختيار" className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2">
                  {([['يستحق البرنامج', p.funnel.eligible], ['المتاح الآن', p.funnel.available], ...(d.manualOnly ? [] : [['طابقت القواعد', p.funnel.filtered], ['بعد السقف', p.funnel.capped], ['بالترشيح', p.funnel.nominated]]), ['أُضيف باليد', p.funnel.manual]] as [string, number][]).map(([label, n]) => (
                    <li key={label} className="rounded-xl border border-line px-3 py-2"><div className="text-sm text-muted">{label}</div><div className="text-xl font-bold tabular-nums">{formatNumber(n)}</div></li>
                  ))}
                  <li className="rounded-xl border border-brand bg-brand-soft px-3 py-2"><div className="text-sm text-brand-strong">يدخل الحملة</div><div className="text-xl font-bold tabular-nums text-brand-strong">{formatNumber(p.funnel.final)}</div></li>
                </ol>
                {p.funnel.eligible > p.funnel.available && <p className="text-sm text-muted">{formatNumber(p.funnel.eligible - p.funnel.available)} مستحقة استُثنيت: استلمت من البرنامج قريباً أو لها فيه استحقاق في حملة قائمة.</p>}
                {fundShort && <Alert tone="warn">المتاح في الصندوق لا يكفي هذا المبلغ: لن تُعتمد الحملة حتى يكفي. ضع سقفاً للمقدار أو اختر صندوقاً آخر.</Alert>}
                {p.funnel.final === 0 && <Alert tone="warn">لا عائلة تطابق هذا الاختيار. وسّع القواعد أو أضف باليد.</Alert>}
              </Card>

              {p.gap > 0 && (
                <motion.section aria-label="إكمال العدد" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4 rounded-xl border-2 border-[#C8862A] bg-warn-soft p-5">
                  <div>
                    <h3 className="text-lg font-bold text-warn-ink">ينقص {formatNumber(p.gap)} عن العدد المستهدف ({d.limit})</h3>
                    <p className="text-warn-ink">القواعد لم تبلغ العدد. أكمله بإحدى ثلاث، أو اتركه ناقصاً وامضِ.</p>
                  </div>
                  {p.relaxations.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <strong className="flex items-center gap-2"><Wand2 aria-hidden="true" className="size-4" />1. بالتقريب: أرخِ قاعدة واحدة</strong>
                      <ul className="flex flex-col gap-1.5">
                        {p.relaxations.map((r) => (
                          <li key={r.label} className="flex flex-wrap items-center gap-3 rounded-lg bg-surface px-3 py-2 shadow-sm">
                            <span className="min-w-0 flex-1">{r.label}</span>
                            <span className="font-semibold tabular-nums">+{formatNumber(r.gain)} عائلة{r.gain >= p.gap ? ' · يسدّ النقص' : ''}</span>
                            <Button variant="secondary" className="min-h-9 px-3" onClick={() => relax(r.label, r.patch)}>طبّق</Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {p.nominees.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-3">
                        <strong className="flex min-w-0 flex-1 items-center gap-2"><Sparkles aria-hidden="true" className="size-4" />2. بالترشيح: الأقرب إلى قواعدك من المستحقين</strong>
                        <Button variant="secondary" className="min-h-9 px-3" onClick={() => set({ nominated: [...d.nominated, ...p.nominees.slice(0, p.gap).map((n) => n.familyNo)] })}>اقبل أول {formatNumber(Math.min(p.gap, p.nominees.length))}</Button>
                      </div>
                      <ul className="flex max-h-72 flex-col gap-1.5 overflow-auto">
                        {p.nominees.map((n) => (
                          <li key={n.familyNo} data-nominee={n.familyNo} className="flex flex-wrap items-center gap-3 rounded-lg bg-surface px-3 py-2 shadow-sm">
                            <span className="min-w-0 flex-1"><strong>{n.headName}</strong> <span className="text-sm tabular-nums text-muted">{n.familyNo} · {n.points ?? '—'} نقطة · {n.members} أفراد</span><br /><span className="text-sm">{n.why}</span></span>
                            <Button variant="secondary" className="min-h-9 px-3" onClick={() => set({ nominated: [...d.nominated, n.familyNo] })}>رشّحها</Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <span><strong>3. باليد:</strong> «أضف عائلة برقمها» أدناه.</span>
                </motion.section>
              )}

              <Card className="flex flex-col gap-4">
                <div className="flex max-w-xl flex-wrap items-end gap-2">
                  <div className="min-w-48 flex-1"><Field label="أضف عائلة برقمها" hint={d.manualOnly ? undefined : 'تدخل فوق العدد والقواعد، ما دامت تستحق البرنامج.'}>{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={addNo} onChange={(e) => setAddNo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }} />}</Field></div>
                  <Button variant="secondary" disabled={digits(addNo).length < 5} onClick={addManual}><UserPlus aria-hidden="true" className="size-4" />أضف العائلة</Button>
                </div>
                {p.rejected.length > 0 && (
                  <Alert>
                    <strong>لا تدخل الحملةَ:</strong>
                    <ul className="mt-1 flex flex-col gap-1">{p.rejected.map((r) => <li key={r.familyNo} className="flex flex-wrap items-center gap-2"><span className="tabular-nums">{r.familyNo}</span><span>{r.reason}</span><button type="button" className="underline" onClick={() => set({ include: d.include.filter((x) => x !== r.familyNo), nominated: d.nominated.filter((x) => x !== r.familyNo) })}>أزلها</button></li>)}</ul>
                  </Alert>
                )}
                {d.exclude.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">مستثناة باليد:</span>
                    {d.exclude.map((no) => <button key={no} type="button" className="rounded-full border border-line-strong px-3 py-1 tabular-nums transition-colors hover:bg-ground" onClick={() => set({ exclude: d.exclude.filter((x) => x !== no) })}>{no} · أرجِعها</button>)}
                  </div>
                )}
                {p.families.length > 0 && (
                  <div className="max-h-[30rem] overflow-auto rounded-xl border border-line">
                    <table className="w-full min-w-[54rem] border-collapse text-sm">
                      <thead className="sticky top-0 z-10 bg-surface shadow-[0_1px_0_var(--color-line)]"><tr className="text-muted">{['#', 'رقم العائلة', 'رب الأسرة', 'الأفراد', 'النقاط', 'استفادت', 'سُجّلت', 'المحلة', `المقدار (${p.unit})`, ''].map((h, i) => <th key={i} scope="col" className="px-3 py-2 text-start font-medium">{h || <span className="sr-only">استثناء</span>}</th>)}</tr></thead>
                      <tbody>
                        {p.families.map((x, i) => (
                          <tr key={x.familyNo} className="border-t border-line transition-colors hover:bg-ground/60">
                            <td className="px-3 py-2 tabular-nums text-muted">{i + 1}</td>
                            <td className="px-3 py-2 font-semibold tabular-nums">{x.familyNo}</td>
                            <td className="px-3 py-2">{x.headName}{x.pickedBy !== 'RULE' && <> <Badge tone="info">{PICKED_AR[x.pickedBy]}</Badge></>}</td>
                            <td className="px-3 py-2 tabular-nums">{x.members}</td>
                            <td className="whitespace-nowrap px-3 py-2 tabular-nums">{x.points ?? '—'}{x.class && <span className="text-muted"> · {CLASS_LETTER[x.class]}</span>}</td>
                            <td className="whitespace-nowrap px-3 py-2">{x.benefits ? <>{x.benefits} مرة<span className="text-muted"> · آخرها {formatDate(x.lastBenefitAt!)}</span></> : <span className="text-muted">لم تستفد</span>}</td>
                            <td className="whitespace-nowrap px-3 py-2">{formatDate(x.registeredAt)}</td>
                            <td className="px-3 py-2">{x.mahalla ?? '—'}</td>
                            <td className="px-3 py-2 tabular-nums">{formatNumber(x.quantity)}</td>
                            <td className="px-3 py-1 text-end"><button type="button" className="min-h-9 rounded-lg border border-line-strong px-3 font-semibold transition-colors hover:border-danger hover:text-danger" onClick={() => dropRow(x)}>استثنِ</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {p.funnel.final > p.families.length && <p className="text-sm text-muted">يُعرض أول {p.families.length} من {formatNumber(p.funnel.final)}. الباقي يدخل الحملة بالترتيب نفسه.</p>}
              </Card>
            </>
          )}

          {step === 'points' && (
            <Card className="flex flex-col gap-5">
              <h2 className="flex items-center gap-2 text-lg font-bold"><MapPin aria-hidden="true" className="size-5 text-brand" />أين تُسلَّم؟</h2>
              <p className="text-sm text-muted">تُقسم العوائل بالتساوي على ما تختاره من نقاط ومتعهدين. عنوان النقطة وساعاتها يُضبطان من صفحة الحملة بعد إنشائها، ويدخلان دعوة الاستلام.</p>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-semibold">نقاط التوزيع</legend>
                <div className="flex flex-wrap gap-2">
                  {points.data?.filter((x) => x.active && !x.agentId).map((x) => (
                    <label key={x.id} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3.5 transition-colors ${d.pointIds.includes(x.id) ? 'border-brand bg-brand-soft' : 'border-line-strong hover:bg-ground'}`}>
                      <input type="checkbox" className="size-[18px] accent-brand" checked={d.pointIds.includes(x.id)}
                        onChange={(e) => set({ pointIds: e.target.checked ? [...d.pointIds, x.id] : d.pointIds.filter((y) => y !== x.id) })} />{x.name}
                    </label>
                  ))}
                  {points.isSuccess && !points.data.some((x) => x.active && !x.agentId) && <span className="text-muted">لا نقاط بعد. أضف أول نقطة.</span>}
                </div>
                <div className="flex max-w-md flex-wrap items-end gap-2">
                  <div className="min-w-40 flex-1"><Field label="نقطة جديدة">{(id) => <Input id={id} value={newPoint} onChange={(e) => setNewPoint(e.target.value)} />}</Field></div>
                  <Button variant="secondary" disabled={newPoint.trim().length < 2} loading={addPoint.isPending} onClick={() => addPoint.mutate()}><Plus aria-hidden="true" className="size-4" />أضف النقطة</Button>
                </div>
              </fieldset>
              {(agents.data?.length ?? 0) > 0 && (
                <div role="group" aria-label="المتعهدون" className="flex flex-col gap-2">
                  <span className="text-sm font-semibold">المتعهدون</span>
                  <span className="text-sm text-muted">لكل متعهد حصة من العوائل يسلّمها بهاتفه، ولا يسلّم لغيرها.</span>
                  <div className="flex flex-wrap gap-2">
                    {agents.data!.map((a) => {
                      const on = !!a.pointId && d.pointIds.includes(a.pointId);
                      return (
                        <label key={a.id} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3.5 transition-colors ${on ? 'border-brand bg-brand-soft' : 'border-line-strong hover:bg-ground'}`}>
                          <input type="checkbox" className="size-[18px] accent-brand" checked={on} disabled={pickAgent.isPending} onChange={() => pickAgent.mutate(a)} />المتعهد {a.fullName}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              {p && d.pointIds.length > 0 && <p className="rounded-lg bg-brand-soft px-3 py-2">{formatNumber(p.funnel.final)} عائلة على {d.pointIds.length} {d.pointIds.length === 1 ? 'جهة' : 'جهات'}: نحو <strong>{formatNumber(Math.ceil(p.funnel.final / d.pointIds.length))}</strong> عائلة لكلٍّ.</p>}
            </Card>
          )}

          {step === 'review' && program && p && (
            <>
              <Card className="flex flex-col gap-4">
                <h2 className="flex items-center gap-2 text-lg font-bold"><CheckCircle2 aria-hidden="true" className="size-5 text-brand" />راجع قبل الحفظ</h2>
                <dl className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-x-6 gap-y-4">
                  {([
                    ['الحملة', d.name, 0], ['البرنامج', program.name, 0], ['المدة', `من ${formatDate(d.startsOn)} إلى ${formatDate(d.endsOn)}`, 0],
                    ...(money ? [['الصندوق', usable.find((x) => x.id === d.fundId)?.name ?? '—', 0] as [string, string, number]] : []),
                    ['يدخل الحملة', `${formatNumber(p.funnel.final)} عائلة · ${formatNumber(p.quantity)} ${p.unit}`, 2],
                    ['تُسلَّم في', d.pointIds.map(pointName).join('، '), 3],
                  ] as [string, string, number][]).map(([label, value, at]) => (
                    <div key={label} className="flex flex-col">
                      <dt className="text-sm text-muted">{label}</dt>
                      <dd className="font-semibold">{value}</dd>
                      <button type="button" className="self-start text-sm font-semibold text-brand-strong underline" onClick={() => go(at)}>عدّل</button>
                    </div>
                  ))}
                </dl>
                <div className="rounded-xl bg-ground px-4 py-3">
                  <div className="text-sm text-muted">كيف اختيرت العوائل</div>
                  <div className="font-semibold">{describeSelection(selection, p.unit).join(' · ')}</div>
                  <button type="button" className="text-sm font-semibold text-brand-strong underline" onClick={() => go(1)}>عدّل القواعد</button>
                </div>
                {p.gap > 0 && <Alert tone="warn">العدد ناقص {formatNumber(p.gap)} عن المستهدف ({d.limit}). لك أن تمضي به، أو <button type="button" className="font-bold underline" onClick={() => go(2)}>تكمله</button>.</Alert>}
                {fundShort && <Alert tone="warn">المتاح في الصندوق لا يكفي: لن تُعتمد الحملة حتى يكفي.</Alert>}
              </Card>
              <Card className="flex flex-col gap-2">
                <h2 className="text-lg font-bold">ماذا بعد الحفظ؟</h2>
                <ol className="flex list-decimal flex-col gap-1 ps-5">
                  <li>تُحفظ الحملة <strong>مسودة</strong>: تعدّلها بهذه الصفحات نفسها ما دامت مسودة.</li>
                  <li>«أرسل للاعتماد»، فيعتمدها موظف غيرك.</li>
                  <li>بالاعتماد تصدر الرموز، وتخرج الدعوة: صورة الرمز بواتساب، أو الرمز الرقمي برسالة نصية.</li>
                </ol>
              </Card>
            </>
          )}
        </motion.div>
      </AnimatePresence>

      <div className="sticky bottom-3 z-20 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface/95 px-4 py-3 shadow-[0_12px_32px_-10px_rgba(16,35,30,0.28)] backdrop-blur">
        <Button variant="secondary" disabled={index === 0} onClick={() => go(index - 1)}><ArrowRight aria-hidden="true" className="size-4" />السابق</Button>
        <div aria-live="polite" className="min-w-0 flex-1 text-center">
          {p ? (
            <span className={settling ? 'opacity-60 transition-opacity' : 'transition-opacity'}>يدخل الحملة <strong className="text-xl text-brand-strong"><CountUp value={p.funnel.final} testId="final" /></strong> عائلة · {formatNumber(p.quantity)} {p.unit}{p.gap > 0 && <span className="text-warn-ink"> · ينقص {formatNumber(p.gap)}</span>}</span>
          ) : <span className="text-muted">الصفحة {index + 1} من {STEPS.length}</span>}
        </div>
        {problems[index] && <span className="text-sm font-medium text-warn-ink">{problems[index]}</span>}
        {index < STEPS.length - 1
          ? <Button disabled={!!problems[index] || (index === 2 && settling)} onClick={() => go(index + 1)}>التالي<ArrowLeft aria-hidden="true" className="size-4" /></Button>
          : <Button disabled={firstBad !== -1 || settling} loading={save.isPending} onClick={() => save.mutate()}>{editing ? 'احفظ التعديل' : 'أنشئ المسودة'}</Button>}
      </div>
    </>
  );
}
