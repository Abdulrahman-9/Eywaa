import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AidMotif } from '../components/AidMotif';
import { Alert, Card, PageHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { formatLongDate, formatNumber } from '../lib/format';

interface Overview {
  families: { approved: number; pendingApproval: number; pendingDedupeReview: number; rejected: number };
  approvedPersons: number;
  openDuplicateFlags: number;
  pendingChangeRequests: number;
  povertyLineIqd: number;
}

function Stat({ label, value, note }: { label: string; value?: number; note?: string }) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-sm text-muted">{label}</span>
      {value === undefined ? <Skeleton className="h-10 w-24" /> : <span className="text-4xl font-bold leading-tight tabular-nums">{formatNumber(value)}</span>}
      {note && <span className="text-sm text-muted">{note}</span>}
    </Card>
  );
}

export function Home() {
  const { data, error } = useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/stats/overview') });
  return (
    <>
      <section aria-label="رسالة المركز" className="flex flex-wrap items-center gap-x-8 gap-y-4 rounded-2xl border border-[#CBDDD5] bg-brand-soft px-7 py-5">
        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-1.5">
          <p className="text-2xl font-bold leading-loose text-brand-strong">﴿ أَوْ إِطْعَامٌ فِي يَوْمٍ ذِي مَسْغَبَةٍ ﴾</p>
          <p className="text-[#33423C]">
            {data
              ? <>في رعاية المركز اليوم <strong>{formatNumber(data.families.approved)}</strong> عائلة معتمدة، فيها <strong>{formatNumber(data.approvedPersons)}</strong> فرداً.</>
              : 'نظام يحفظ لكل عائلة حقها.'}
          </p>
        </div>
        <AidMotif className="h-auto w-full max-w-[22.5rem] flex-[0_1_22.5rem]" />
      </section>

      <PageHeader title="الرئيسية" description={formatLongDate(new Date())} />
      {error && <Alert>{error.message}</Alert>}

      <section aria-label="المؤشرات" className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-4">
        <Stat label="العوائل المعتمدة" value={data?.families.approved} note={data && `${formatNumber(data.approvedPersons)} فرداً`} />
        <Stat label="بانتظار الاعتماد" value={data?.families.pendingApproval} />
        <Stat label="معلَّقة لشبهة تكرار" value={data?.families.pendingDedupeReview} note={data && `${formatNumber(data.openDuplicateFlags)} شبهة مفتوحة`} />
        <Stat label="طلبات تعديل تنتظر" value={data?.pendingChangeRequests} />
      </section>

      {data && (
        <p className="text-muted">
          خط الفقر المعتمد: <strong className="text-ink">{formatNumber(data.povertyLineIqd)} دينار</strong> للفرد في الشهر.
        </p>
      )}
    </>
  );
}
