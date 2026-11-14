import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, ClipboardList, Hourglass, Scale, Search } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AssignDialog, EffectChips, INSPECTION_DECIDERS, InspectionDialog, InspectionRow, type Inspection } from '../components/Inspections';
import { Alert, Button, Card, CountUp, Input, PageHeader, Segmented, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { formatDays, formatNumber } from '../lib/format';

interface Summary {
  families: { total: number; inspected: number; open: number; never: number; raisedNow: number; loweredNow: number };
  inspectedPercent: number; waiting: number; assigned: number; late: number; oldestDays: number | null;
  decided: { approved: number; rejected: number; none: number; raised: number; lowered: number; removed: number };
  changedPercent: number; reports: { submitted: number; withMismatch: number; mismatchPercent: number };
  double: { total: number; agreed: number; agreedPercent: number }; cap: number; lateDays: number;
}
type Tab = 'WAITING' | 'ASSIGNED' | 'DECIDED';

export function Inspections() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'WAITING';
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const canDecide = !!user && INSPECTION_DECIDERS.includes(user.role);
  const summary = useQuery({ queryKey: ['inspections', 'summary'], queryFn: () => api<Summary>('/inspections/summary') });
  const list = useQuery({ queryKey: ['inspections', 'list', tab, q.trim()], queryFn: () => api<Inspection[]>(`/inspections?${new URLSearchParams({ status: tab, ...(q.trim() ? { q: q.trim() } : {}) })}`) });

  if (summary.isPending) return <Skeleton className="h-64 w-full" />;
  if (summary.error) return <Alert>{summary.error.message}</Alert>;
  const s = summary.data;
  const tile = (icon: React.ReactNode, label: string, value: React.ReactNode, note: string, warn = false) => (
    <Card className={cn('flex items-center gap-4', warn && '!border-[#C8862A]')}>
      <span className={cn('grid size-12 flex-none place-items-center rounded-xl', warn ? 'bg-warn-soft text-warn-ink' : 'bg-brand-soft text-brand-strong')}>{icon}</span>
      <div className="min-w-0"><div className="text-sm text-muted">{label}</div><div className="text-2xl font-bold leading-tight">{value}</div><div className="text-sm text-muted">{note}</div></div>
    </Card>
  );

  return (
    <>
      <PageHeader title="الكشف الميداني" description="بعد التسجيل يُكلَّف متعهد أو اثنان بزيارة العائلة: يطابقان ما سُجّل بما في الواقع، ويرفعان ما رأيا. ثم تعتمد الكشف فتقرّر أثره."
        action={canDecide && <Button onClick={() => setAssigning(true)}><ClipboardCheck aria-hidden="true" className="size-4" />كلّف بالكشف</Button>} />

      <section aria-label="مؤشرات الكشف" className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-4">
        <Card className="flex flex-col gap-1.5">
          <div className="text-sm text-muted">العوائل المكشوفة</div>
          <div className="flex items-baseline gap-2"><span className="text-2xl font-bold tabular-nums" data-testid="inspected-percent">{s.inspectedPercent}%</span><span className="text-sm text-muted">{formatNumber(s.families.inspected)} من {formatNumber(s.families.total)}</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-ground"><div className="h-full rounded-full bg-brand" style={{ width: `${s.inspectedPercent}%` }} /></div>
          <div className="text-sm text-muted">{formatNumber(s.families.never)} لم تُكشف بعد</div>
        </Card>
        {tile(<Scale aria-hidden="true" className="size-6" />, 'تنتظر قرارك', <CountUp value={s.waiting} testId="waiting" />, 'رُفع تقريرها ولم يُفصل فيها', s.waiting > 0)}
        {tile(<Hourglass aria-hidden="true" className="size-6" />, 'قيد الكشف', <CountUp value={s.assigned} />, s.late ? `${s.late} منها متأخر أكثر من ${formatDays(s.lateDays)}` : s.oldestDays !== null ? `أقدمها منذ ${formatDays(s.oldestDays)}` : 'لا تكليف قائم', s.late > 0)}
        {tile(<ClipboardList aria-hidden="true" className="size-6" />, 'غيّر الكشف حال العائلة', <>{s.changedPercent}%</>, `من ${formatNumber(s.decided.approved)} كشف معتمد`)}
      </section>

      {s.decided.approved > 0 && (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">أثر الكشوف المعتمدة</h2>
          <EffectChips decided={s.decided} />
          <ul className="flex flex-col gap-1 text-sm text-muted">
            <li>في <strong className="text-ink">{s.reports.mismatchPercent}%</strong> من التقارير بند واحد على الأقل لا يطابق ما في السجل ({formatNumber(s.reports.withMismatch)} من {formatNumber(s.reports.submitted)}).</li>
            {s.double.total > 0 && <li>اتفق الكاشفان في <strong className="text-ink">{s.double.agreed} من {s.double.total}</strong> كشف مزدوج ({s.double.agreedPercent}%).</li>}
            <li>الآن: <strong className="text-ink">{formatNumber(s.families.raisedNow)}</strong> عائلة مرفوعة النقاط بالكشف و<strong className="text-ink">{formatNumber(s.families.loweredNow)}</strong> مخفوضة. أقصى ما يغيّره الكشف <strong className="text-ink">{s.cap}</strong> نقاط، ويضبطه مدير النظام من الإعدادات.</li>
            {s.decided.rejected > 0 && <li>{formatNumber(s.decided.rejected)} كشف لم يُعتمد.</li>}
          </ul>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="أي الكشوف" value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} options={[['WAITING', `تنتظر قرارك (${s.waiting})`], ['ASSIGNED', `قيد الكشف (${s.assigned})`], ['DECIDED', 'السجل']]} />
        <div className="relative min-w-56 flex-1"><Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><Input aria-label="ابحث في الكشوف" className="ps-9" placeholder="رقم العائلة، رقم الكشف، اسم، محلة" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      <Card>
        {list.isPending && <Skeleton className="h-24 w-full" />}
        {list.error && <Alert>{list.error.message}</Alert>}
        {list.isSuccess && list.data.length === 0 && <p className="text-muted">{q.trim() ? 'لا كشف يطابق.' : tab === 'WAITING' ? 'لا كشف ينتظر قرارك.' : tab === 'ASSIGNED' ? 'لا تكليف قائم. «كلّف بالكشف» ليبدأ.' : 'لم يُفصل في كشف بعد.'}</p>}
        <ul className="flex flex-col">{list.data?.map((i) => <InspectionRow key={i.id} i={i} onOpen={() => setOpenId(i.id)} />)}</ul>
      </Card>
      <InspectionDialog id={openId} onClose={() => setOpenId(null)} />
      <AssignDialog open={assigning} onClose={() => setAssigning(false)} />
    </>
  );
}
