import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Coins, MapPin, PackageOpen, Pencil, Plus, Search, Store, User } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, CountUp, Dialog, Field, Input, PageHeader, Segmented, Select, Skeleton } from '../components/ui';
import { VoucherDialog } from '../components/Voucher';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { formatAgo, formatDate, formatDateTime, formatDays, formatNumber, digits } from '../lib/format';

export interface Box {
  id: string; code: string; location: string; address: string | null; hostName: string | null; hostPhone: string | null; fundId: string; fund: string;
  agentId: string | null; agentName: string | null; status: 'ACTIVE' | 'RETIRED'; installedOn: string; note: string | null; retiredAt: string | null; retireNote: string | null;
  openings: number; total: number; average: number; lastOpenedAt: string | null; lastAmount: number | null; lastBy: string | null; daysSince: number; stale: boolean; expectedNow: number | null;
}
export interface Collection {
  id: string; boxId: string; code: string; location: string; amount: number; collectedAt: string; sealNo: string | null; note: string | null; direct: boolean;
  collector: string; recorder: string; expected: number | null; low: boolean; entryId: string | null; entryNo: string | null; fund: string;
}
interface Summary {
  active: number; retired: number; stale: number; neverOpened: number; unassigned: number; collectedThisMonth: number; openingsThisMonth: number; totalCollected: number;
  monthly: { month: string; total: number; openings: number }[]; staleDays: number;
}
interface FundLite { id: string; name: string }
interface UserLite { id: string; fullName: string }
type Filter = 'active' | 'due' | 'retired';

const int = (v: string) => Number(digits(v)) || 0;
const monthName = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { month: 'short' });
const monthFull = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { month: 'long', year: 'numeric' });
const EMPTY = { code: '', location: '', address: '', hostName: '', hostPhone: '', fundId: '', agentId: '', installedOn: '', note: '' };

/** حصيلة الصناديق شهراً بشهر. سلسلة واحدة، فلا مفتاح ألوان: العنوان يسمّيها. تحت كل عمود قيمته لمن يمرّ عليه، وجدول لقارئ الشاشة. */
function MonthBars({ data }: { data: Summary['monthly'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.total));
  const shown = hover ?? data.length - 1;
  const d = data[shown];
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-bold">حصيلة الصناديق في 12 شهراً</span>
        <span className="text-sm text-muted" aria-live="polite">{monthFull.format(new Date(`${d.month}-01`))}: <strong className="text-ink tabular-nums">{formatNumber(d.total)}</strong> دينار في {d.openings} فتح</span>
      </figcaption>
      <div className="flex h-32 items-end gap-0.5 border-b border-line-strong" onMouseLeave={() => setHover(null)}>
        {data.map((m, i) => (
          <button key={m.month} type="button" aria-label={`${monthFull.format(new Date(`${m.month}-01`))}: ${formatNumber(m.total)} دينار`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
            className="group flex h-full min-w-0 flex-1 items-end justify-center px-[1px] focus:outline-none">
            <span className={cn('block w-full max-w-9 rounded-t transition-colors duration-150', i === shown ? 'bg-brand-strong' : 'bg-brand/55 group-hover:bg-brand')} style={{ height: m.total ? `${Math.max(3, (m.total / max) * 100)}%` : '2px' }} />
          </button>
        ))}
      </div>
      <div aria-hidden="true" className="flex gap-0.5 text-xs text-muted">{data.map((m) => <span key={m.month} className="min-w-0 flex-1 truncate text-center">{monthName.format(new Date(`${m.month}-01`))}</span>)}</div>
      <table className="sr-only"><caption>حصيلة الصناديق شهراً بشهر</caption><thead><tr><th scope="col">الشهر</th><th scope="col">الحصيلة</th><th scope="col">عدد الفتحات</th></tr></thead>
        <tbody>{data.map((m) => <tr key={m.month}><td>{m.month}</td><td>{m.total}</td><td>{m.openings}</td></tr>)}</tbody></table>
    </figure>
  );
}

function BoxDialog({ id, canBook, agents, funds, onClose }: { id: string | null; canBook: boolean; agents: UserLite[]; funds: FundLite[]; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['boxes', id], queryFn: () => api<Box & { collections: Collection[] }>(`/boxes/${id}`), enabled: !!id });
  const [mode, setMode] = useState<'view' | 'collect' | 'edit'>('view');
  const [c, setC] = useState({ amount: '', by: '', direct: false, sealNo: '', note: '' });
  const [e, setE] = useState(EMPTY);
  const [retiring, setRetiring] = useState(false);
  const [voucher, setVoucher] = useState<string | null>(null);
  const b = q.data;
  useEffect(() => { setMode('view'); }, [id]);
  useEffect(() => {
    if (!b) return;
    if (mode === 'collect') setC({ amount: '', by: b.agentId ?? '', direct: !b.agentId, sealNo: '', note: '' });
    if (mode === 'edit') setE({ code: b.code, location: b.location, address: b.address ?? '', hostName: b.hostName ?? '', hostPhone: b.hostPhone ?? '', fundId: b.fundId, agentId: b.agentId ?? '', installedOn: '', note: b.note ?? '' });
    // يُملأ عند فتح النموذج، لا عند كل تحديث في الخلفية: وإلا مُحي المبلغ المعدود والمحاسب يكتبه.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, b?.id]);
  const refresh = () => { for (const key of ['boxes', 'agents', 'agent', 'accounting']) queryClient.invalidateQueries({ queryKey: [key] }); };
  const collect = useMutation({
    mutationFn: () => api<Collection>(`/boxes/${id}/collections`, { method: 'POST', body: { amount: int(c.amount), ...(c.direct ? { direct: true } : { collectedBy: c.by }), ...(c.sealNo.trim() ? { sealNo: c.sealNo.trim() } : {}), ...(c.note.trim() ? { note: c.note.trim() } : {}) } }),
    onSuccess: (r) => { toast(r.amount ? `سُجّل الفتح: ${formatNumber(r.amount)} دينار بالسند ${r.entryNo}${r.low ? '. دون المعتاد لهذا الصندوق' : ''}` : 'سُجّل الفتح: وُجد فارغاً', r.low ? 'info' : 'ok'); setMode('view'); refresh(); },
  });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/boxes/${id}`, { method: 'PATCH', body }),
    onSuccess: () => { toast('حُفظ'); setMode('view'); setRetiring(false); refresh(); },
  });
  const saveEdit = () => patch.mutate({ location: e.location.trim(), address: e.address.trim() || null, hostName: e.hostName.trim() || null, hostPhone: e.hostPhone.trim() || null, fundId: e.fundId, agentId: e.agentId || null, note: e.note.trim() || null });
  const fact = (icon: React.ReactNode, label: string, value: React.ReactNode) => <div className="flex items-start gap-2"><span className="mt-1 text-muted">{icon}</span><div className="min-w-0"><div className="text-sm text-muted">{label}</div><div className="font-semibold">{value}</div></div></div>;

  return (
    <>
      <Dialog open={!!id} title={b ? `صندوق ${b.code} — ${b.location}` : 'صندوق تبرعات'} onClose={onClose} wide>
        {q.isPending && <Skeleton className="h-64 w-full" />}
        {q.error && <Alert>{q.error.message}</Alert>}
        {b && mode === 'view' && (
          <>
            <div className="flex flex-wrap gap-2">
              {b.status === 'RETIRED' ? <Badge>مرفوع من موقعه{b.retireNote ? `: ${b.retireNote}` : ''}</Badge> : b.stale ? <Badge tone="warn">لم يُفتح منذ {formatDays(b.daysSince)}</Badge> : <Badge tone="ok">عامل</Badge>}
              <Badge tone="info">يدخل «{b.fund}»</Badge>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3">
              {fact(<MapPin aria-hidden="true" className="size-4" />, 'الموقع', <>{b.location}{b.address && <div className="font-normal text-muted">{b.address}</div>}</>)}
              {fact(<Store aria-hidden="true" className="size-4" />, 'صاحب الموقع', b.hostName ? <>{b.hostName}{b.hostPhone && <div className="font-normal"><bdi dir="ltr">{b.hostPhone}</bdi></div>}</> : 'لم يُذكر')}
              {fact(<User aria-hidden="true" className="size-4" />, 'المتعهد المحصِّل', b.agentName ?? 'لا متعهد له')}
              {fact(<CalendarClock aria-hidden="true" className="size-4" />, 'وُضع في', <bdi>{formatDate(b.installedOn)}</bdi>)}
            </div>
            <div className="grid grid-cols-2 gap-3 rounded-xl bg-ground p-4 sm:grid-cols-4">
              {[['مجموع ما جُمع', formatNumber(b.total)], ['عدد الفتحات', String(b.openings)], ['معدَّل الفتح', formatNumber(b.average)], ['يُنتظر فيه الآن', b.expectedNow === null ? 'لا يُقدَّر بعد' : `نحو ${formatNumber(b.expectedNow)}`]].map(([l, v]) => (
                <div key={l}><div className="text-sm text-muted">{l}</div><div className="text-lg font-bold tabular-nums">{v}</div></div>
              ))}
            </div>
            {!b.hostPhone && b.status === 'ACTIVE' && <p className="text-sm text-muted">لا هاتف لصاحب الموقع: لن يُبلَّغ بما يُعدّ عند الفتح. إبلاغه شاهد على العدّ من خارج المركز.</p>}
            <h3 className="font-bold">سجل الفتح</h3>
            {b.collections.length === 0 && <p className="text-muted">لم يُفتح بعد.</p>}
            <ul className="flex max-h-72 flex-col overflow-y-auto">
              {b.collections.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-0" data-testid="collection">
                  <div className="min-w-0 flex-1"><strong><bdi>{formatDateTime(x.collectedAt)}</bdi></strong>
                    <div className="text-sm text-muted">{x.direct ? `فُتح في المركز أمام ${x.recorder}` : `بيد ${x.collector}`}{!x.direct && x.recorder !== x.collector ? ` · سجّله ${x.recorder}` : ''}{x.sealNo ? ` · ختم ${x.sealNo}` : ''}{x.note ? ` · ${x.note}` : ''}</div></div>
                  {x.low && <Badge tone="warn">دون المعتاد (نحو {formatNumber(x.expected ?? 0)})</Badge>}
                  <strong className="tabular-nums">{x.amount ? formatNumber(x.amount) : 'فارغ'}</strong>
                  {x.entryId && <button type="button" className="font-semibold text-brand-strong underline tabular-nums" onClick={() => setVoucher(x.entryId)}><bdi>{x.entryNo}</bdi></button>}
                </li>
              ))}
            </ul>
            {canBook && (
              <div className="flex flex-wrap justify-end gap-3">
                {b.status === 'ACTIVE'
                  ? <Button variant="danger" onClick={() => { patch.reset(); setRetiring(true); }}>ارفعه من موقعه</Button>
                  : <Button variant="secondary" loading={patch.isPending} onClick={() => patch.mutate({ status: 'ACTIVE' })}>أعده إلى العمل</Button>}
                <Button variant="secondary" onClick={() => { patch.reset(); setMode('edit'); }}><Pencil aria-hidden="true" className="size-4" />عدّل</Button>
                {b.status === 'ACTIVE' && <Button onClick={() => { collect.reset(); setMode('collect'); }}><PackageOpen aria-hidden="true" className="size-4" />سجّل فتحاً</Button>}
              </div>
            )}
          </>
        )}
        {b && mode === 'collect' && (
          <>
            <p className="text-muted">المتعهد يسجّل فتح صندوقه من هاتفه. وهنا يسجّله المحاسب عنه، أو يسجّل فتحاً جرى في المركز أمامه.</p>
            {collect.error && <Alert>{collect.error.message}</Alert>}
            <Segmented label="أين فُتح" value={c.direct ? 'direct' : 'agent'} onChange={(v) => setC({ ...c, direct: v === 'direct' })} options={[['agent', 'حمله متعهد'], ['direct', 'فُتح في المركز']]} />
            {c.direct
              ? <p className="rounded-lg bg-info-soft px-3 py-2 text-sm text-info-ink">يدخل المبلغ نقد «{b.fund}» مباشرة ولا يمرّ بذمة أحد.</p>
              : <Field label="من فتحه وحمل ما فيه" hint="يدخل المبلغ ذمته حتى يسلّمه">{(fid) => <Select id={fid} value={c.by} onChange={(ev) => setC({ ...c, by: ev.target.value })}><option value="">اختر المتعهد</option>{agents.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}</Field>}
            <Field label="ما عُدّ فيه بالدينار" hint={b.expectedNow !== null ? `المعتاد لهذه المدة نحو ${formatNumber(b.expectedNow)}. اكتب 0 إن وُجد فارغاً.` : 'اكتب 0 إن وُجد فارغاً'}>
              {(fid) => <Input id={fid} dir="ltr" inputMode="numeric" value={c.amount} onChange={(ev) => setC({ ...c, amount: ev.target.value })} />}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="رقم الختم (إن وُجد)">{(fid) => <Input id={fid} value={c.sealNo} onChange={(ev) => setC({ ...c, sealNo: ev.target.value })} />}</Field>
              <Field label="ملاحظة">{(fid) => <Input id={fid} value={c.note} onChange={(ev) => setC({ ...c, note: ev.target.value })} />}</Field>
            </div>
            <div className="flex flex-wrap justify-end gap-3"><Button variant="secondary" onClick={() => setMode('view')}>رجوع</Button><Button loading={collect.isPending} disabled={c.amount.trim() === '' || (!c.direct && !c.by)} onClick={() => collect.mutate()}>سجّل الفتح</Button></div>
          </>
        )}
        {b && mode === 'edit' && (
          <>
            {patch.error && <Alert>{patch.error.message}</Alert>}
            <BoxFields f={e} setF={setE} agents={agents} funds={funds} editing />
            <div className="flex flex-wrap justify-end gap-3"><Button variant="secondary" onClick={() => setMode('view')}>رجوع</Button><Button loading={patch.isPending} disabled={e.location.trim().length < 2 || !e.fundId} onClick={saveEdit}>احفظ</Button></div>
          </>
        )}
      </Dialog>
      <ReasonDialog open={retiring} title="رفع الصندوق من موقعه" confirmLabel="ارفع الصندوق" danger pending={patch.isPending} error={patch.error?.message}
        onClose={() => setRetiring(false)} onConfirm={(note) => patch.mutate({ status: 'RETIRED', retireNote: note })}>
        <p>يبقى سجل الصندوق وما جُمع منه، ولا يُحصَّل بعد رفعه. افتحه وسجّل ما فيه قبل أن ترفعه.</p>
      </ReasonDialog>
      <VoucherDialog id={voucher} onClose={() => setVoucher(null)} />
    </>
  );
}

function BoxFields({ f, setF, agents, funds, editing }: { f: typeof EMPTY; setF: (v: typeof EMPTY) => void; agents: UserLite[]; funds: FundLite[]; editing?: boolean }) {
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field label="الموقع" hint="اسم المحل أو الجامع أو العيادة">{(id) => <Input id={id} value={f.location} onChange={set('location')} />}</Field>
        {!editing && <Field label="رقم الصندوق" hint="يُرقَّم تلقائياً إن تُرك">{(id) => <Input id={id} value={f.code} onChange={set('code')} />}</Field>}
      </div>
      <Field label="العنوان">{(id) => <Input id={id} value={f.address} onChange={set('address')} />}</Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="صاحب الموقع">{(id) => <Input id={id} value={f.hostName} onChange={set('hostName')} />}</Field>
        <Field label="هاتفه" hint="يُبلَّغ بما يُعدّ عند كل فتح">{(id) => <Input id={id} dir="ltr" inputMode="tel" value={f.hostPhone} onChange={set('hostPhone')} />}</Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="تدخل تحصيلاته صندوق">{(id) => <Select id={id} value={f.fundId} onChange={set('fundId')}><option value="">اختر الصندوق المحاسبي</option>{funds.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        <Field label="المتعهد المحصِّل">{(id) => <Select id={id} value={f.agentId} onChange={set('agentId')}><option value="">لا متعهد له بعد</option>{agents.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}</Field>
      </div>
      {!editing && <Field label="تاريخ وضعه" hint="اليوم إن تُرك">{(id) => <Input id={id} type="date" value={f.installedOn} onChange={set('installedOn')} />}</Field>}
      <Field label="ملاحظة">{(id) => <Input id={id} value={f.note} onChange={set('note')} />}</Field>
    </>
  );
}

export function Boxes() {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canBook = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT';
  const [params, setParams] = useSearchParams();
  const open = params.get('open');
  const q = useQuery({ queryKey: ['boxes'], queryFn: () => api<{ boxes: Box[]; summary: Summary }>('/boxes') });
  const funds = useQuery({ queryKey: ['accounting'], queryFn: () => api<{ funds: FundLite[] }>('/accounting/summary') });
  const agents = useQuery({ queryKey: ['users', 'DISTRIBUTION_AGENT'], queryFn: () => api<UserLite[]>('/users/brief?role=DISTRIBUTION_AGENT'), enabled: user?.role !== 'AUDITOR' });
  const [filter, setFilter] = useState<Filter>('active');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState(EMPTY);
  const create = useMutation({
    mutationFn: () => api<Box>('/boxes', { method: 'POST', body: Object.fromEntries(Object.entries({ ...f, location: f.location.trim() }).filter(([, v]) => v.trim() !== '')) }),
    onSuccess: (b) => { toast(`أُضيف الصندوق ${b.code}`); setAdding(false); setF(EMPTY); queryClient.invalidateQueries({ queryKey: ['boxes'] }); },
  });
  const setOpen = (id: string | null) => setParams(id ? { open: id } : {}, { replace: true });
  const list = useMemo(() => {
    const all = q.data?.boxes ?? [];
    const term = search.trim();
    return all.filter((b) => (filter === 'retired' ? b.status === 'RETIRED' : b.status === 'ACTIVE' && (filter === 'active' || b.stale)))
      .filter((b) => !term || [b.code, b.location, b.address, b.hostName, b.agentName].some((v) => v?.includes(term)));
  }, [q.data, filter, search]);

  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.error) return <Alert>{q.error.message}</Alert>;
  const s = q.data.summary;
  const tile = (icon: React.ReactNode, label: string, value: number, note: string, warn?: boolean) => (
    <Card className={cn('flex items-center gap-4', warn && value > 0 && '!border-[#C8862A]')}>
      <span className={cn('grid size-12 flex-none place-items-center rounded-xl', warn && value > 0 ? 'bg-warn-soft text-warn-ink' : 'bg-brand-soft text-brand-strong')}>{icon}</span>
      <div className="min-w-0"><div className="text-sm text-muted">{label}</div><div className="text-2xl font-bold leading-tight"><CountUp value={value} /></div><div className="text-sm text-muted">{note}</div></div>
    </Card>
  );

  return (
    <>
      <PageHeader title="صناديق التبرعات" description="صناديق موزَّعة في مواقع المدينة. كل فتح يُسجَّل بما عُدّ فيه ومن حمله، ويُبلَّغ به صاحب الموقع."
        action={canBook && <Button onClick={() => { create.reset(); setAdding(true); }}><Plus aria-hidden="true" className="size-4" />صندوق جديد</Button>} />
      <section aria-label="مؤشرات الصناديق" className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-4">
        {tile(<Store aria-hidden="true" className="size-6" />, 'صناديق عاملة', s.active, s.unassigned ? `${s.unassigned} بلا متعهد` : 'لكلٍّ متعهده')}
        {tile(<Coins aria-hidden="true" className="size-6" />, 'حصيلة هذا الشهر', s.collectedThisMonth, `في ${s.openingsThisMonth} فتح`)}
        {tile(<AlertTriangle aria-hidden="true" className="size-6" />, 'تنتظر الفتح', s.stale, `لم تُفتح منذ أكثر من ${s.staleDays} يوماً`, true)}
        {tile(<PackageOpen aria-hidden="true" className="size-6" />, 'مجموع ما جُمع', s.totalCollected, 'منذ وُضعت الصناديق')}
      </section>
      <Card><MonthBars data={s.monthly} /></Card>

      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="أي الصناديق" value={filter} onChange={setFilter} options={[['active', `العاملة (${s.active})`], ['due', `تنتظر الفتح (${s.stale})`], ['retired', `المرفوعة (${s.retired})`]]} />
        <div className="relative min-w-56 flex-1"><Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><Input aria-label="ابحث في الصناديق" className="ps-9" placeholder="رقم، موقع، صاحب محل، متعهد" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>
      {list.length === 0 ? <Card><p className="text-muted">{q.data.boxes.length === 0 ? 'لا صندوق بعد. يضيفه المحاسب بموقعه ومتعهده.' : 'لا صندوق يطابق.'}</p></Card> : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-4">
          {list.map((b) => (
            <button key={b.id} type="button" onClick={() => setOpen(b.id)} data-testid="box-card"
              className={cn('flex flex-col gap-2.5 rounded-xl border bg-surface p-5 text-start shadow-[0_1px_2px_rgba(16,35,30,0.04)] transition-[box-shadow,transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-brand hover:shadow-[0_8px_24px_-10px_rgba(16,35,30,0.25)]', b.stale ? 'border-[#C8862A]' : 'border-line', b.status === 'RETIRED' && 'opacity-60')}>
              <div className="flex items-start gap-3">
                <span className="grid size-11 flex-none place-items-center rounded-lg bg-brand-soft font-bold text-brand-strong tabular-nums"><bdi>{b.code}</bdi></span>
                <div className="min-w-0 flex-1"><div className="truncate text-lg font-bold">{b.location}</div><div className="truncate text-sm text-muted">{b.agentName ? `يحصّله ${b.agentName}` : 'بلا متعهد'}{b.hostName ? ` · عند ${b.hostName}` : ''}</div></div>
              </div>
              <div className="flex flex-wrap gap-2">{b.status === 'RETIRED' ? <Badge>مرفوع</Badge> : b.stale ? <Badge tone="warn">{b.openings ? `لم يُفتح منذ ${formatDays(b.daysSince)}` : `لم يُفتح قط · ${formatDays(b.daysSince)}`}</Badge> : <Badge tone="ok">فُتح {formatAgo(b.lastOpenedAt)}</Badge>}</div>
              <div className="grid grid-cols-3 gap-2 border-t border-line pt-2.5 text-sm">
                {[['آخر فتح', b.lastAmount === null ? '—' : formatNumber(b.lastAmount)], ['المعدَّل', b.openings ? formatNumber(b.average) : '—'], ['يُنتظر الآن', b.expectedNow === null ? '—' : formatNumber(b.expectedNow)]].map(([l, v]) => (
                  <div key={l}><div className="text-muted">{l}</div><div className="font-bold tabular-nums">{v}</div></div>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}

      <Dialog open={adding} title="صندوق تبرعات جديد" onClose={() => setAdding(false)} wide>
        {create.error && <Alert>{create.error.message}</Alert>}
        <BoxFields f={f} setF={setF} agents={agents.data ?? []} funds={funds.data?.funds ?? []} />
        <div className="flex flex-wrap justify-end gap-3"><Button variant="secondary" onClick={() => setAdding(false)}>إلغاء</Button><Button loading={create.isPending} disabled={f.location.trim().length < 2 || !f.fundId} onClick={() => create.mutate()}>أضف الصندوق</Button></div>
      </Dialog>
      <BoxDialog id={open} canBook={canBook} agents={agents.data ?? []} funds={funds.data?.funds ?? []} onClose={() => setOpen(null)} />
    </>
  );
}
