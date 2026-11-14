import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../components/toast';
import { Alert, Button, Card, Dialog, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatNumber } from '../lib/format';
import { CLASS_AR } from './Scoring';

interface Month { month: string; families: number; deliveries: number }
export interface Donor { id: string; name: string; phone: string | null; cash: number; inKindReceipts: number }
interface DonorReport {
  donor: { name: string }; totalGiven: number; totalSpentShare: number;
  cash: { fundId: string; fund: string; restrictedTo: string | null; given: number; sharePercent: number; fundSpent: number; spentShare: number; familiesServedByFund: number; housesByFund: number }[];
  inKind: { item: string; unit: string; quantity: number; distributedShare: number }[];
}
interface Stale { familyId: string; familyNo: string; headName: string; class: string | null; lastTouch: string }
interface Staff { username: string; fullName: string; total: number; actions: Record<string, number> }

const MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
const monthName = (m: string) => MONTHS[Number(m.slice(5)) - 1];
const today = () => new Date().toISOString().slice(0, 10);

export function Reports() {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const role = user?.role ?? 'AUDITOR';
  const canDonors = ['ADMIN', 'ACCOUNTANT', 'AUDITOR'].includes(role);
  const canAddDonor = role === 'ADMIN' || role === 'ACCOUNTANT';
  const canFamilies = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'AUDITOR'].includes(role);
  const canCampaign = ['ADMIN', 'DISTRIBUTION_MANAGER', 'ACCOUNTANT', 'AUDITOR'].includes(role);
  const canStaff = role === 'ADMIN' || role === 'AUDITOR';

  const monthly = useQuery({ queryKey: ['reports', 'monthly'], queryFn: () => api<Month[]>('/reports/monthly'), staleTime: 0 });
  const donors = useQuery({ queryKey: ['donors'], queryFn: () => api<Donor[]>('/donors'), enabled: canDonors, staleTime: 0 });
  const stale = useQuery({ queryKey: ['reports', 'stale'], queryFn: () => api<Stale[]>('/reports/stale?months=12'), staleTime: 0 });
  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: () => api<{ id: string; name: string }[]>('/campaigns'), enabled: canCampaign });
  const [range, setRange] = useState({ from: today().slice(0, 8) + '01', to: today() });
  const staff = useQuery({ queryKey: ['reports', 'staff', range], queryFn: () => api<Staff[]>(`/reports/staff?from=${range.from}&to=${range.to}`), enabled: canStaff && range.from <= range.to });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [reportOf, setReportOf] = useState<string | null>(null);
  const [cls, setCls] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const report = useQuery({ queryKey: ['donors', reportOf, 'report'], queryFn: () => api<DonorReport>(`/donors/${reportOf}/report`), enabled: !!reportOf });

  const addDonor = useMutation({
    mutationFn: () => api('/donors', { method: 'POST', body: { name: name.trim() } }),
    onSuccess: () => { toast('أُضيف المتبرع'); setName(''); setAdding(false); queryClient.invalidateQueries({ queryKey: ['donors'] }); },
  });
  const get = useMutation({ mutationFn: (v: { path: string; name: string }) => download(v.path, v.name), onError: (e) => toast(e.message, 'error'), onSuccess: () => toast('نُزّل التقرير') });
  const max = Math.max(1, ...(monthly.data?.map((m) => m.families) ?? [1]));
  const half = monthly.data?.slice(-6) ?? [];

  return (
    <>
      <PageHeader title="المتبرعون والتقارير" description="من أعطى، وفيمَ صُرف عطاؤه، ومن انتفع به." action={canAddDonor && <Button onClick={() => setAdding(true)}>متبرع جديد</Button>} />

      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-3"><h2 className="text-lg font-bold">العوائل التي وصلها عطاء في كل شهر</h2><span className="text-sm text-muted">آخر ستة أشهر. الشهر الجاري لم يكتمل.</span></div>
        {monthly.isPending ? <Skeleton className="h-40 w-full" /> : (
          <>
            <div role="img" aria-label={`رسم أعمدة: ${half.map((m) => `${monthName(m.month)} ${m.families}`).join('، ')}`} className="grid h-48 grid-cols-6 items-end gap-3 pt-2">
              {half.map((m, i) => (
                <div key={m.month} className="flex h-full flex-col items-center justify-end gap-1.5">
                  <span className="text-sm font-semibold tabular-nums">{formatNumber(m.families)}</span>
                  <div className={`w-full max-w-[4.5rem] rounded-t-md ${i === half.length - 1 ? 'bg-[#9DBFB4]' : 'bg-brand'}`} style={{ height: `${Math.max((m.families / max) * 150, m.families ? 4 : 0)}px` }} />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-6 gap-3 border-t border-line-strong pt-1.5 text-center text-sm text-muted">{half.map((m) => <span key={m.month}>{monthName(m.month)}</span>)}</div>
          </>
        )}
      </Card>

      <div className="flex flex-wrap items-start gap-5">
        {canDonors && (
          <Card className="flex min-w-0 flex-[2_1_28rem] flex-col gap-3">
            <h2 className="text-lg font-bold">المتبرعون</h2>
            {donors.data?.length === 0 && <p className="text-muted">لا متبرعين بعد. أضف متبرعاً ثم انسب إليه سند القبض أو وارد المخزن.</p>}
            <ul className="flex flex-col">
              {donors.data?.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 border-b border-line py-2.5 last:border-0">
                  <div className="min-w-0 flex-1"><strong>{d.name}</strong><div className="text-sm text-muted">نقداً {formatNumber(d.cash)} دينار{d.inKindReceipts ? ` · ${d.inKindReceipts} تبرع عيني` : ''}</div></div>
                  <Button variant="secondary" onClick={() => setReportOf(d.id)}>تقريره</Button>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted">تقرير المتبرع يذكر أعداد العوائل لا أسماءها.</p>
          </Card>
        )}

        <Card className="flex min-w-0 flex-[1_1_20rem] flex-col gap-4">
          <h2 className="text-lg font-bold">تقارير جاهزة للتنزيل</h2>
          {canFamilies && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-32 flex-1"><Field label="كشف العوائل المعتمدة">{(id) => <Select id={id} value={cls} onChange={(e) => setCls(e.target.value)}><option value="">كل الفئات</option>{Object.entries(CLASS_AR).map(([k, v]) => <option key={k} value={k}>الفئة {v}</option>)}</Select>}</Field></div>
              <Button variant="secondary" disabled={get.isPending} onClick={() => get.mutate({ path: `/reports/families.csv?status=APPROVED${cls ? `&class=${cls}` : ''}`, name: 'العوائل.csv' })}>نزّل</Button>
            </div>
          )}
          {canCampaign && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-32 flex-1"><Field label="كشف التسليم لحملة">{(id) => <Select id={id} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}><option value="">اختر الحملة</option>{campaigns.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field></div>
              <Button variant="secondary" disabled={!campaignId || get.isPending} onClick={() => get.mutate({ path: `/reports/campaign/${campaignId}.csv`, name: 'كشف التسليم.csv' })}>نزّل</Button>
            </div>
          )}
          <p className="text-sm text-muted">الملفات بصيغة CSV تفتح في Excel. تنزيل كشف فيه أسماء العوائل يُسجَّل باسمك.</p>
        </Card>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <Card className="flex min-w-0 flex-[1_1_22rem] flex-col gap-3">
          <h2 className="text-lg font-bold">ملفات تقادم تقييمها {stale.data ? `(${stale.data.length})` : ''}</h2>
          <p className="text-sm text-muted">معتمدة ولم تُمسّ بياناتها منذ أكثر من سنة. إعادة التقييم عند الطلب، فهذا تنبيه لا إلزام.</p>
          {stale.data?.length === 0 && <p className="text-muted">لا ملف تقادم تقييمه.</p>}
          <ul className="flex max-h-64 flex-col overflow-y-auto">
            {stale.data?.map((s) => (
              <li key={s.familyId} className="flex justify-between gap-3 border-b border-line py-2 last:border-0">
                <Link to={`/families/${s.familyId}`} className="font-semibold text-brand-strong">{s.familyNo} · {s.headName}</Link>
                <span className="flex-none text-sm text-muted">{formatDate(s.lastTouch)}</span>
              </li>
            ))}
          </ul>
        </Card>

        {canStaff && (
          <Card className="flex min-w-0 flex-[1_1_22rem] flex-col gap-3">
            <h2 className="text-lg font-bold">عمليات الموظفين</h2>
            <div className="grid grid-cols-2 gap-3">
              <Field label="من">{(id) => <Input id={id} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
              <Field label="إلى">{(id) => <Input id={id} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
            </div>
            {staff.data?.length === 0 && <p className="text-muted">لا عمليات في هذه المدة.</p>}
            <ul className="flex flex-col">
              {staff.data?.map((s) => (
                <li key={s.username} className="flex justify-between gap-3 border-b border-line py-2 last:border-0"><span><strong>{s.fullName}</strong> <span dir="ltr" className="text-sm text-muted">{s.username}</span></span><strong className="tabular-nums">{formatNumber(s.total)}</strong></li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <Dialog open={adding} title="متبرع جديد" onClose={() => { addDonor.reset(); setAdding(false); }}>
        {addDonor.error && <Alert>{addDonor.error.message}</Alert>}
        <Field label="اسم المتبرع" hint="أو كنيته إن لم يُرد ذكر اسمه">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <div className="flex flex-wrap justify-end gap-3"><Button variant="secondary" onClick={() => setAdding(false)}>إلغاء</Button><Button disabled={name.trim().length < 2 || addDonor.isPending} onClick={() => addDonor.mutate()}>أضف المتبرع</Button></div>
      </Dialog>

      <Dialog open={!!reportOf} title={report.data ? `تقرير ${report.data.donor.name}` : 'تقرير المتبرع'} onClose={() => setReportOf(null)}>
        {report.isPending ? <Skeleton className="h-32 w-full" /> : report.error ? <Alert>{report.error.message}</Alert> : report.data && (
          <div className="flex flex-col gap-4 print:text-black">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-brand-soft p-3"><div className="text-sm text-muted">أعطى نقداً</div><strong className="text-2xl tabular-nums">{formatNumber(report.data.totalGiven)}</strong></div>
              <div className="rounded-lg bg-brand-soft p-3"><div className="text-sm text-muted">صُرف من عطائه</div><strong className="text-2xl tabular-nums">{formatNumber(report.data.totalSpentShare)}</strong></div>
            </div>
            {report.data.cash.map((c) => (
              <div key={c.fundId} className="flex flex-col gap-1 border-t border-line pt-3">
                <strong>{c.fund}{c.restrictedTo ? ` (لـ«${c.restrictedTo}» فقط)` : ''}</strong>
                <span>أعطى {formatNumber(c.given)} دينار، وهي {c.sharePercent}% من وارد الصندوق.</span>
                <span>صُرف من الصندوق {formatNumber(c.fundSpent)}، ونصيب عطائه منها {formatNumber(c.spentShare)}.</span>
                <span>انتفعت من الصندوق {formatNumber(c.familiesServedByFund)} عائلة{c.housesByFund ? `، وبُني به ${c.housesByFund} منزل` : ''}.</span>
              </div>
            ))}
            {report.data.inKind.map((k) => (
              <div key={k.item} className="flex flex-col gap-1 border-t border-line pt-3"><strong>عيني: {k.item}</strong><span>أعطى {formatNumber(k.quantity)} {k.unit}، وُزِّع منها نحو {formatNumber(k.distributedShare)}.</span></div>
            ))}
            <p className="text-sm text-muted">دينار الصندوق لا يتميّز عن ديناره، فنصيب المتبرع مما صُرف محسوب بالتناسب مع حصته من وارد الصندوق.</p>
            <div className="flex flex-wrap justify-end gap-3 print:hidden"><Button variant="secondary" onClick={() => window.print()}>اطبع</Button><Button onClick={() => setReportOf(null)}>إغلاق</Button></div>
          </div>
        )}
      </Dialog>
    </>
  );
}
