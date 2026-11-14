import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';
import { Alert, Badge, Card } from './ui';

interface Daily {
  unit: string; families: number; delivered: number; remaining: number;
  days: { day: string; delivered: number; quantity: number; byProxy: number; offline: number; incidents: number; cumulative: number; percent: number; points: { point: string; delivered: number; quantity: number }[] }[];
}
interface CampaignAlert { kind: string; severity: 'HIGH' | 'MEDIUM'; title: string; detail: string; at: string | null; familyNo?: string; who?: string }

/** متابعة الحملة: إنذارات ما يشبه الاحتيال، ثم ما صُرف يوماً بيوم. */
export function CampaignMonitor({ campaignId, live, canSeeAlerts }: { campaignId: string; live: boolean; canSeeAlerts: boolean }) {
  const every = live ? 30_000 : false;
  const daily = useQuery({ queryKey: ['campaign', campaignId, 'daily'], queryFn: () => api<Daily>(`/campaigns/${campaignId}/daily`), refetchInterval: every });
  const alerts = useQuery({ queryKey: ['campaign', campaignId, 'alerts'], queryFn: () => api<CampaignAlert[]>(`/campaigns/${campaignId}/alerts`), enabled: canSeeAlerts, refetchInterval: every });
  const d = daily.data;
  const peak = Math.max(1, ...(d?.days.map((x) => x.delivered) ?? []));

  return (
    <>
      {canSeeAlerts && (
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="min-w-0 flex-1 text-lg font-bold">إنذارات</h2>
            {alerts.data && (alerts.data.length ? <Badge tone="danger">{alerts.data.length} إنذار</Badge> : <Badge tone="ok">لا شيء يلفت النظر</Badge>)}
          </div>
          {alerts.error && <Alert>{alerts.error.message}</Alert>}
          {alerts.data?.length === 0 && <p className="text-muted">يُنذر النظام إن عُرض رمز مستعمل ثلاث مرات، أو أُدخلت خمسة رموز خاطئة من جهاز في عشر دقائق، أو عُرض رمز في نقطتين، أو سُلِّم استحقاق مرتين، أو كثر الاستلام بالوكالة عند موظف، أو سُلِّم ليلاً.</p>}
          <ul className="flex flex-col gap-2">
            {alerts.data?.map((a, i) => (
              <li key={i} data-alert={a.kind} className={`flex flex-col gap-0.5 rounded-lg border-s-4 px-4 py-3 ${a.severity === 'HIGH' ? 'border-danger bg-danger-soft' : 'border-[#C8862A] bg-warn-soft'}`}>
                <div className="flex flex-wrap items-center gap-2"><strong className={a.severity === 'HIGH' ? 'text-danger' : 'text-warn-ink'}>{a.title}</strong>{a.at && <bdi className="text-sm text-muted">{formatDateTime(a.at)}</bdi>}</div>
                <span>{a.detail}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">الصرف يوماً بيوم</h2>
        {daily.error && <Alert>{daily.error.message}</Alert>}
        {d && d.days.length === 0 && <p className="text-muted">لم يُصرف شيء بعد.</p>}
        {d && d.days.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-sm">
              <thead><tr className="text-muted">{['اليوم', 'سُلِّم', `المقدار (${d.unit})`, 'النقاط', 'بالوكالة', 'بلاغات', 'التراكم'].map((h) => <th key={h} scope="col" className="border-b border-line p-2 text-start font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {d.days.map((x) => (
                  <tr key={x.day} className="border-b border-line align-top last:border-0">
                    <td className="whitespace-nowrap p-2 font-semibold">{formatDate(x.day)}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-2"><span className="w-10 tabular-nums">{formatNumber(x.delivered)}</span><span aria-hidden="true" className="h-2.5 rounded-full bg-brand" style={{ width: `${Math.max(2, (x.delivered / peak) * 100)}%`, maxWidth: '8rem' }} /></div>
                    </td>
                    <td className="p-2 tabular-nums">{formatNumber(x.quantity)}</td>
                    <td className="p-2">{x.points.map((p) => `${p.point} ${formatNumber(p.delivered)}`).join(' · ') || '—'}</td>
                    <td className="p-2 tabular-nums">{x.byProxy || '—'}</td>
                    <td className={`p-2 tabular-nums ${x.incidents ? 'font-semibold text-danger' : ''}`}>{x.incidents || '—'}</td>
                    <td className="whitespace-nowrap p-2 tabular-nums">{formatNumber(x.cumulative)} · {x.percent}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d && d.days.length > 0 && <p className="text-sm text-muted">سُلِّم {formatNumber(d.delivered)} من {formatNumber(d.families)}، وبقي {formatNumber(d.remaining)}.</p>}
      </Card>
    </>
  );
}
