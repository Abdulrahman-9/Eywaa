import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Card, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatNumber } from '../lib/format';

export const CAMPAIGN_STATUS = {
  DRAFT: ['مسودة', 'neutral'], PENDING_APPROVAL: ['تنتظر الاعتماد', 'warn'], ACTIVE: ['جارية', 'ok'],
  CLOSED: ['مُقفلة', 'neutral'], CANCELLED: ['ملغاة', 'danger'], REJECTED: ['مرفوضة', 'danger'],
} as const;
export type CampaignStatus = keyof typeof CAMPAIGN_STATUS;
interface Row { id: string; name: string; status: CampaignStatus; unit: string; startsOn: string; endsOn: string; program: string; closedAt: string | null; families: number; delivered: number; quantity: number }
export interface Point { id: string; name: string; active: boolean }

const GROUPS = {
  ALL: ['الكل', null],
  CURRENT: ['الجارية', ['ACTIVE']],
  WAITING: ['مسودات ومعلّقة', ['DRAFT', 'PENDING_APPROVAL']],
  PAST: ['السابقة', ['CLOSED', 'CANCELLED', 'REJECTED']],
} as const;
type Group = keyof typeof GROUPS;

/** الحملات كلها، الجارية والسابقة. يُبحث فيها بالاسم، وتُصفّى بالحال والبرنامج والسنة. */
export function Campaigns() {
  const { user } = useAuth();
  const [group, setGroup] = useState<Group>('ALL');
  const [q, setQ] = useState('');
  const [program, setProgram] = useState('');
  const [year, setYear] = useState('');
  const list = useQuery({ queryKey: ['campaigns'], queryFn: () => api<Row[]>('/campaigns') });
  const canManage = user?.role === 'ADMIN' || user?.role === 'DISTRIBUTION_MANAGER';
  const flagged = useQuery({ queryKey: ['campaign-alerts'], queryFn: () => api<{ campaignId: string; alerts: number; high: number }[]>('/campaign-alerts'), enabled: canManage || user?.role === 'AUDITOR', refetchInterval: 60_000 });
  const alertsOf = (id: string) => flagged.data?.find((x) => x.campaignId === id);
  const all = list.data ?? [];
  const programs = [...new Set(all.map((c) => c.program))].sort();
  const years = [...new Set(all.map((c) => c.startsOn.slice(0, 4)))].sort().reverse();
  const count = (g: Group) => all.filter((c) => !GROUPS[g][1] || (GROUPS[g][1] as readonly string[]).includes(c.status)).length;
  const shown = all.filter((c) =>
    (!GROUPS[group][1] || (GROUPS[group][1] as readonly string[]).includes(c.status))
    && (!q.trim() || c.name.includes(q.trim())) && (!program || c.program === program) && (!year || c.startsOn.startsWith(year)));
  return (
    <>
      <PageHeader title="حملات التوزيع" description="كل حملة توزّع برنامجاً على مستحقيه في مدة ونقاط معلومة. الحملات السابقة تبقى هنا بعوائلها وحال كلٍّ منها."
        action={canManage && <Link to="/campaigns/new" className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 font-semibold text-white hover:bg-brand-strong">حملة جديدة</Link>} />
      {list.error && <Alert>{list.error.message}</Alert>}
      {list.isPending && <Skeleton className="h-24 w-full" />}
      {list.data?.length === 0 && <Card className="py-10 text-center text-muted">لا حملات بعد. أنشئ برنامجاً ثم حملة لتوزيعه.</Card>}
      {all.length > 0 && (
        <Card className="flex flex-wrap items-end gap-3">
          <div role="group" aria-label="حال الحملة" className="flex flex-wrap gap-2">
            {(Object.keys(GROUPS) as Group[]).map((g) => (
              <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}
                className={`min-h-11 rounded-lg border px-3.5 font-semibold ${group === g ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line-strong hover:bg-ground'}`}>{GROUPS[g][0]} ({count(g)})</button>
            ))}
          </div>
          <div className="min-w-52 flex-[2]"><Field label="بحث باسم الحملة">{(id) => <Input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}</Field></div>
          <div className="min-w-40 flex-1"><Field label="البرنامج">{(id) => <Select id={id} value={program} onChange={(e) => setProgram(e.target.value)}><option value="">الكل</option>{programs.map((x) => <option key={x}>{x}</option>)}</Select>}</Field></div>
          <div className="min-w-28"><Field label="السنة">{(id) => <Select id={id} value={year} onChange={(e) => setYear(e.target.value)}><option value="">الكل</option>{years.map((x) => <option key={x}>{x}</option>)}</Select>}</Field></div>
        </Card>
      )}
      {all.length > 0 && shown.length === 0 && <Card className="py-8 text-center text-muted">لا حملة تطابق البحث.</Card>}
      <div className="flex flex-col gap-3">
        {shown.map((c) => (
          <Link key={c.id} to={`/campaigns/${c.id}`} className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-surface p-5 hover:border-brand">
            <div className="min-w-0 flex-[1_1_18rem]">
              <div className="flex flex-wrap items-center gap-2"><strong className="text-lg">{c.name}</strong><Badge tone={CAMPAIGN_STATUS[c.status][1]}>{CAMPAIGN_STATUS[c.status][0]}</Badge>{alertsOf(c.id) && <Badge tone="danger">{alertsOf(c.id)!.alerts} إنذار</Badge>}</div>
              <span className="text-sm text-muted">{c.program} · من {formatDate(c.startsOn)} إلى {formatDate(c.endsOn)}{c.closedAt && ` · أُقفلت ${formatDate(c.closedAt)}`}</span>
            </div>
            <div className="min-w-48 flex-1">
              <div className="mb-1 flex justify-between text-sm"><span>{c.status === 'CLOSED' ? 'استلم' : 'سُلِّم'} {formatNumber(c.delivered)} من {formatNumber(c.families)}</span><span>{c.families ? Math.round((c.delivered / c.families) * 100) : 0}%</span></div>
              <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-line"><div className="h-2 bg-brand" style={{ width: `${c.families ? (c.delivered / c.families) * 100 : 0}%` }} /></div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
