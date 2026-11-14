import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CampaignFamilies } from '../components/CampaignFamilies';
import { PAYOUT_READERS, Payouts } from '../components/Payouts';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';
import { ORDER_AR } from './CampaignNew';
import { CAMPAIGN_STATUS, type CampaignStatus } from './Campaigns';
import { CLASS_AR } from './Scoring';
import { TAGS } from '../lib/labels';
import { ReconcileTable, type Reconcile } from './Warehouse';

interface Selection {
  classes?: string[]; minPoints?: number; maxPoints?: number; registeredFrom?: string; registeredTo?: string; membersMin?: number; membersMax?: number;
  tagsAny?: string[]; mahallas?: string[]; order?: keyof typeof ORDER_AR; limit?: number; maxQuantity?: number; include?: string[]; nominated?: string[]; exclude?: string[]; manualOnly?: boolean;
  maxBenefits?: { count: number; months: number; scope: 'PROGRAM' | 'ALL' }; notSinceDays?: { days: number; scope: 'PROGRAM' | 'ALL' };
}

/** كيف اختيرت عوائل الحملة، بكلام يُقرأ: للمعتمِد اليوم، ولمن يرجع إليها بعد عام. */
function describeSelection(s: Selection, unit: string): string[] {
  if (s.manualOnly) return [`اختيرت باليد: ${s.include?.length ?? 0} عائلة بأرقامها`];
  const out: string[] = [];
  if (s.classes?.length) out.push(`الفئة ${s.classes.map((c) => CLASS_AR[c as keyof typeof CLASS_AR]).join(' أو ')}`);
  if (s.minPoints !== undefined) out.push(`${s.minPoints} نقطة فأكثر`);
  if (s.membersMin !== undefined || s.membersMax !== undefined) out.push(`الأفراد ${s.membersMin ?? 1} إلى ${s.membersMax ?? 'ما فوق'}`);
  if (s.registeredFrom || s.registeredTo) out.push(`سُجّلت ${s.registeredFrom ? `من ${formatDate(s.registeredFrom)} ` : ''}${s.registeredTo ? `حتى ${formatDate(s.registeredTo)}` : ''}`.trim());
  if (s.tagsAny?.length) out.push(s.tagsAny.map((t) => TAGS[t as keyof typeof TAGS]).join(' أو '));
  if (s.mahallas?.length) out.push(`المحلة: ${s.mahallas.join('، ')}`);
  const scope = (x: 'PROGRAM' | 'ALL') => (x === 'ALL' ? 'من كل البرامج' : 'من هذا البرنامج');
  if (s.maxBenefits) out.push(s.maxBenefits.count === 0 ? `لم تستفد ${scope(s.maxBenefits.scope)} في آخر ${s.maxBenefits.months} شهراً` : `استفادت ${s.maxBenefits.count} مرة على الأكثر ${scope(s.maxBenefits.scope)} في آخر ${s.maxBenefits.months} شهراً`);
  if (s.notSinceDays) out.push(`لم تستلم ${scope(s.notSinceDays.scope)} منذ ${s.notSinceDays.days} يوماً`);
  if (!out.length) out.push('كل من يستحق البرنامج');
  if (s.limit || s.maxQuantity) out.push(`المستهدف ${[s.limit && `${formatNumber(s.limit)} عائلة`, s.maxQuantity && `${formatNumber(s.maxQuantity)} ${unit}`].filter(Boolean).join(' و')}، ${ORDER_AR[s.order ?? 'FAMILY_NO']}`);
  if (s.nominated?.length) out.push(`أُكمل العدد بالترشيح: ${s.nominated.length}`);
  if (s.include?.length) out.push(`أُضيفت باليد: ${s.include.length}`);
  if (s.exclude?.length) out.push(`استُثنيت باليد: ${s.exclude.length}`);
  return out;
}

interface Detail {
  id: string; name: string; status: CampaignStatus; unit: string; program: string; startsOn: string; endsOn: string;
  createdBy: string; decidedBy: string | null; decisionNote: string | null; fundId: string | null; selection: Selection;
  totals: { families: number; quantity: number; delivered: number; deliveredQuantity: number; byProxy: number };
  points: { id: string; name: string; address: string | null; hours: string | null; assigned: number; quantity: number; delivered: number; deliveredQuantity: number; lastDelivery: string | null }[];
  recent: { id: string; familyId: string; familyNo: string; receiver: 'HEAD' | 'PROXY'; receiverName: string; quantity: number; deliveredAt: string; mode: 'ONLINE' | 'OFFLINE' | 'TRANSFER'; point: string; by: string; hasProof: boolean }[];
  incidents: { id: string; kind: string; message: string; at: string; point: string | null; by: string; familyNo: string | null; deviceId: string | null }[];
}

const STAGES: [string, CampaignStatus[]][] = [
  ['المستحقون', ['DRAFT']], ['الاعتماد', ['PENDING_APPROVAL']], ['التسليم', ['ACTIVE']], ['الإقفال', ['CLOSED']],
];
const ORDER: CampaignStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'CLOSED'];

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return <Card className="flex flex-col gap-0.5"><span className="text-sm text-muted">{label}</span><span className="text-3xl font-bold leading-tight tabular-nums">{formatNumber(value)}</span>{note && <span className="text-sm text-muted">{note}</span>}</Card>;
}

export function Campaign() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'approve' | 'reject' | 'cancel' | 'close' | null>(null);
  const [place, setPlace] = useState<{ id: string; name: string; address: string; hours: string } | null>(null);
  const savePlace = useMutation({
    mutationFn: () => api(`/points/${place!.id}`, { method: 'POST', body: { address: place!.address, hours: place!.hours } }),
    onSuccess: () => { toast('حُفظ مكان الحضور'); setPlace(null); queryClient.invalidateQueries({ queryKey: ['campaign', id] }); },
  });
  const remind = useMutation({
    mutationFn: () => api<{ reminded: number }>(`/campaigns/${id}/remind`, { method: 'POST' }),
    onSuccess: (r) => toast(`ذُكّرت ${r.reminded} عائلة لم تستلم`),
    onError: (e) => toast(e.message, 'error'),
  });
  const q = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api<Detail>(`/campaigns/${id}`),
    // الحملة الجارية تتحدث أرقامها وحدها.
    refetchInterval: (query) => (query.state.data?.status === 'ACTIVE' ? 10_000 : false),
  });
  const canStock = !!user && ['ADMIN', 'STOREKEEPER', 'DISTRIBUTION_MANAGER', 'ACCOUNTANT', 'AUDITOR'].includes(user.role);
  const reconcile = useQuery({ queryKey: ['campaign', id, 'reconcile'], queryFn: () => api<Reconcile>(`/inventory/reconcile/${id}`), enabled: canStock, refetchInterval: 30_000 });
  const act = useMutation({
    mutationFn: (v: { verb: string; note?: string }) => api(`/campaigns/${id}/${v.verb}`, { method: 'POST', body: v.note ? { note: v.note } : {} }),
    onSuccess: (_d, v) => {
      toast({ submit: 'أُرسلت الحملة إلى الاعتماد', approve: 'اعتُمدت الحملة وصدرت رموزها', reject: 'رُفضت الحملة', cancel: 'أُلغيت الحملة', close: 'أُقفلت الحملة' }[v.verb] ?? 'تمّ');
      setDialog(null);
      queryClient.invalidateQueries({ queryKey: ['campaign', id] });
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (e) => { if (!dialog) toast(e.message, 'error'); },
  });

  if (q.isPending) return <Skeleton className="h-48 w-full" />;
  if (q.error) return <Alert>{q.error.message}</Alert>;
  const c = q.data;
  const canManage = user?.role === 'ADMIN' || user?.role === 'DISTRIBUTION_MANAGER';
  const mine = c.createdBy === user?.username;
  const left = c.totals.families - c.totals.delivered;
  const stageIndex = ORDER.indexOf(c.status);
  const pct = c.totals.families ? Math.round((c.totals.delivered / c.totals.families) * 100) : 0;

  return (
    <>
      <PageHeader
        title={c.name}
        description={`${c.program} · من ${formatDate(c.startsOn)} إلى ${formatDate(c.endsOn)} · أنشأها ${c.createdBy}`}
        action={
          <div className="flex flex-wrap items-center gap-2.5">
            <Badge tone={CAMPAIGN_STATUS[c.status][1]}>{CAMPAIGN_STATUS[c.status][0]}</Badge>
            {canManage && c.status === 'DRAFT' && <><Button variant="danger" onClick={() => setDialog('cancel')}>إلغاء الحملة</Button><Button disabled={act.isPending} onClick={() => act.mutate({ verb: 'submit' })}>أرسل للاعتماد</Button></>}
            {canManage && c.status === 'PENDING_APPROVAL' && !mine && <><Button variant="danger" onClick={() => setDialog('reject')}>رفض</Button><Button onClick={() => setDialog('approve')}>اعتماد الحملة</Button></>}
            {canManage && c.status === 'ACTIVE' && <><Link to={`/campaigns/${id}/tokens`} className="inline-flex min-h-11 items-center rounded-lg border border-line-strong bg-surface px-4 font-semibold hover:bg-ground">الرموز للطباعة</Link><Button variant="secondary" disabled={remind.isPending || left === 0} onClick={() => remind.mutate()}>ذكّر من لم يستلم</Button><Button onClick={() => setDialog('close')}>إقفال الحملة</Button></>}
          </div>
        }
      />

      {stageIndex >= 0 && (
        <ol aria-label="مراحل الحملة" className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2">
          {STAGES.map(([label], i) => (
            <li key={label} className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 ${i === stageIndex ? 'border-brand bg-brand-soft' : 'border-line bg-surface'}`}>
              <span className={`text-sm ${i <= stageIndex ? 'text-brand-strong' : 'text-muted'}`}>{i < stageIndex ? 'تمّ' : i === stageIndex ? 'الآن' : 'لاحقاً'}</span>
              <strong className={i > stageIndex ? 'text-muted' : ''}>{label}</strong>
            </li>
          ))}
        </ol>
      )}

      {c.status === 'PENDING_APPROVAL' && mine && <Alert tone="warn"><strong>هذه الحملة أنشأتَها أنت.</strong> يعتمدها مدير توزيع آخر أو مدير النظام، وعندها تصدر الرموز.</Alert>}
      {(c.status === 'REJECTED' || c.status === 'CANCELLED') && <Alert><strong>{CAMPAIGN_STATUS[c.status][0]}.</strong> {c.decisionNote}</Alert>}

      <section aria-label="مؤشرات الحملة" className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-4">
        <Stat label="المستحقون" value={c.totals.families} note={`${formatNumber(c.totals.quantity)} ${c.unit}`} />
        <Stat label="سُلِّم" value={c.totals.delivered} note={`${pct}% · ${formatNumber(c.totals.deliveredQuantity)} ${c.unit}`} />
        <Stat label={c.status === 'CLOSED' ? 'لم يستلم' : 'بقي'} value={left} />
        <Stat label="استلم بالوكالة" value={c.totals.byProxy} note="كلهم وكلاء مسجَّلون" />
      </section>

      <p className="rounded-lg border border-line bg-surface px-4 py-3"><span className="text-muted">كيف اختيرت عوائلها: </span>{describeSelection(c.selection ?? {}, c.unit).join(' · ')}</p>

      {c.fundId && ['ACTIVE', 'CLOSED'].includes(c.status) && user && PAYOUT_READERS.includes(user.role) && <Payouts campaignId={id} active={c.status === 'ACTIVE'} />}

      <div className="flex flex-wrap items-start gap-5">
        <Card className="flex min-w-0 flex-[2_1_30rem] flex-col gap-3">
          <h2 className="text-lg font-bold">نقاط التوزيع</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] border-collapse text-sm">
              <thead><tr className="text-muted">{['النقطة', 'سُلِّم من المعيَّن', 'المقدار', 'آخر تسليم'].map((h) => <th key={h} scope="col" className="border-b border-line p-2 text-start font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {c.points.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0">
                    <td className="p-2">
                      <strong>{p.name}</strong>
                      <div className="text-muted">{[p.address, p.hours].filter(Boolean).join(' · ') || 'بلا عنوان ولا ساعات'}</div>
                      {canManage && <button type="button" className="font-semibold text-brand-strong underline" onClick={() => { savePlace.reset(); setPlace({ id: p.id, name: p.name, address: p.address ?? '', hours: p.hours ?? '' }); }}>مكان الحضور</button>}
                    </td>
                    <td className="p-2 tabular-nums">{formatNumber(p.delivered)} من {formatNumber(p.assigned)}</td>
                    <td className="p-2 tabular-nums">{formatNumber(p.deliveredQuantity)} من {formatNumber(p.quantity)} {c.unit}</td>
                    <td className="p-2">{p.lastDelivery ? formatDateTime(p.lastDelivery) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="flex min-w-0 flex-[1_1_20rem] flex-col gap-3">
          <h2 className="text-lg font-bold">آخر عمليات التسليم</h2>
          {c.recent.length === 0 && <p className="text-muted">لم يُسلَّم شيء بعد.</p>}
          <ul className="flex flex-col">
            {c.recent.map((d) => (
              <li key={d.id} className="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <Link to={`/families/${d.familyId}`} className="font-semibold text-brand-strong">{d.familyNo}</Link>
                  <div className="text-sm text-muted">{d.receiver === 'PROXY' ? 'الوكيل' : 'رب الأسرة'}: {d.receiverName}{d.point ? ` · ${d.point}` : ''}{d.mode === 'OFFLINE' ? ' · دون اتصال' : d.mode === 'TRANSFER' ? ' · حوالة أو محفظة' : ''}{d.hasProof ? ' · بصورة' : ''}</div>
                </div>
                <span className="flex-none text-sm text-muted">{formatDateTime(d.deliveredAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {reconcile.data && reconcile.data.item && (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">مطابقة الصادر بالمسلَّم</h2>
          <ReconcileTable data={reconcile.data} />
        </Card>
      )}

      {c.incidents.length > 0 && (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">ما رُفض وما كُشف ({c.incidents.length})</h2>
          <ul className="flex flex-col">
            {c.incidents.map((i) => (
              <li key={i.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-2.5 last:border-0">
                <Badge tone={i.kind === 'DOUBLE_DELIVERY' || i.kind === 'BAD_SIGNATURE' ? 'danger' : 'warn'}>{i.message.replace('لا تسلّم: ', '')}</Badge>
                <span className="min-w-0 flex-1">{i.familyNo ? `العائلة ${i.familyNo} · ` : ''}{i.point ?? ''} · الموظف {i.by}{i.deviceId ? ` · الجهاز ${i.deviceId}` : ''}</span>
                <span className="text-sm text-muted">{formatDateTime(i.at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog open={!!place} title={`مكان الحضور: ${place?.name ?? ''}`} onClose={() => setPlace(null)}>
        <p className="text-muted">يُكتبان في دعوة الاستلام والتذكير، ليعرف المدعوّ أين يحضر ومتى.</p>
        {savePlace.error && <Alert>{savePlace.error.message}</Alert>}
        <Field label="العنوان">{(fid) => <Input id={fid} value={place?.address ?? ''} onChange={(e) => setPlace({ ...place!, address: e.target.value })} placeholder="مثال: شارع المستشفى، مقابل الصيدلية" />}</Field>
        <Field label="ساعات الحضور">{(fid) => <Input id={fid} value={place?.hours ?? ''} onChange={(e) => setPlace({ ...place!, hours: e.target.value })} placeholder="مثال: من 9 صباحاً إلى 2 ظهراً" />}</Field>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setPlace(null)}>إلغاء</Button>
          <Button disabled={savePlace.isPending} onClick={() => savePlace.mutate()}>احفظ</Button>
        </div>
      </Dialog>

      <CampaignFamilies campaignId={id} campaignStatus={c.status} unit={c.unit} points={c.points} canManage={!!canManage} canExport={!!user && ['ADMIN', 'DISTRIBUTION_MANAGER', 'ACCOUNTANT', 'AUDITOR'].includes(user.role)} />

      <ReasonDialog open={dialog === 'approve'} title="تأكيد اعتماد الحملة" confirmLabel="اعتماد الحملة" required={false}
        pending={act.isPending} error={act.error?.message} onClose={() => { act.reset(); setDialog(null); }} onConfirm={(note) => act.mutate({ verb: 'approve', note })}>
        <p>سيُوزَّع <strong>{formatNumber(c.totals.quantity)} {c.unit}</strong> على <strong>{formatNumber(c.totals.families)} عائلة</strong> في {c.points.length} نقاط.</p>
        <p className="text-sm text-muted">بعد الاعتماد تصدر الرموز، ولا يُرجع عنه إلا بإقفال الحملة.</p>
      </ReasonDialog>
      <ReasonDialog open={dialog === 'reject'} title="رفض الحملة" confirmLabel="رفض الحملة" danger
        pending={act.isPending} error={act.error?.message} onClose={() => { act.reset(); setDialog(null); }} onConfirm={(note) => act.mutate({ verb: 'reject', note })} />
      <ReasonDialog open={dialog === 'cancel'} title="إلغاء الحملة" confirmLabel="إلغاء الحملة" danger
        pending={act.isPending} error={act.error?.message} onClose={() => { act.reset(); setDialog(null); }} onConfirm={(note) => act.mutate({ verb: 'cancel', note })}>
        <p>تُلغى المسودة واستحقاقاتها، وتعود عوائلها مستحقة لحملة أخرى.</p>
      </ReasonDialog>
      <Dialog open={dialog === 'close'} title="إقفال الحملة" onClose={() => { act.reset(); setDialog(null); }}>
        <p>سُلِّم <strong>{formatNumber(c.totals.delivered)}</strong> من {formatNumber(c.totals.families)}. بالإقفال تُلغى رموز <strong>{formatNumber(left)}</strong> عائلة لم تستلم، فلا تُقبل بعده.</p>
        <p className="text-sm text-muted">إن كان في الميدان جهاز لم يزامن بعد، فانتظر مزامنته قبل الإقفال.</p>
        {act.error && <Alert>{act.error.message}</Alert>}
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setDialog(null)}>تراجع</Button>
          <Button disabled={act.isPending} onClick={() => act.mutate({ verb: 'close' })}>إقفال الحملة</Button>
        </div>
      </Dialog>
    </>
  );
}
