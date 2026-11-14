import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Printer } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Field, Input, Skeleton } from '../components/ui';
import { categoryLabel, KIND_AR, VoucherDialog } from '../components/Voucher';
import { api } from '../lib/api';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';
import { printSheet } from '../lib/print';

interface Line { id: string; no: string; kind: string; description: string; party: string | null; category: string | null; at: string; in: number; out: number; balance: number; by: string; approvedBy: string | null }
interface Group { category: string; amount: number; count: number }
interface Statement { fundId: string; fund: string; from: string | null; to: string | null; opening: number; received: number; paid: number; closing: number; custody: number; income: Group[]; spending: Group[]; lines: Line[] }

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** حصص الأبواب من مجموعها: شريط لكل باب بطوله، وقيمته ونسبته نصاً. */
function Shares({ title, groups, empty }: { title: string; groups: Group[]; empty: string }) {
  const total = groups.reduce((s, g) => s + g.amount, 0);
  return (
    <Card className="flex min-w-0 flex-[1_1_20rem] flex-col gap-3">
      <div className="flex items-baseline gap-3"><h2 className="flex-1 text-lg font-bold">{title}</h2><strong className="tabular-nums">{formatNumber(total)}</strong></div>
      {groups.length === 0 && <p className="text-muted">{empty}</p>}
      {groups.map((g) => (
        <div key={g.category} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2"><span className="flex-1 font-semibold">{categoryLabel(g.category)}</span><span className="text-sm text-muted">{g.count} سند</span><span className="tabular-nums">{formatNumber(g.amount)}</span><span className="w-12 text-end text-sm text-muted tabular-nums">{total ? Math.round((g.amount / total) * 100) : 0}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-ground"><div className="h-full rounded-full bg-brand" style={{ width: `${total ? (g.amount / total) * 100 : 0}%` }} /></div>
        </div>
      ))}
    </Card>
  );
}

export function FundStatement() {
  const { id } = useParams<{ id: string }>();
  const today = new Date();
  const [from, setFrom] = useState(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(iso(today));
  const [voucher, setVoucher] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['accounting', 'statement', id, from, to], queryFn: () => api<Statement>(`/accounting/funds/${id}/statement?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`) });
  const s = q.data;
  const range = (months: number) => { const d = new Date(today.getFullYear(), today.getMonth() - months, 1); setFrom(iso(d)); setTo(months === 1 ? iso(new Date(today.getFullYear(), today.getMonth(), 0)) : iso(today)); };

  return (
    <>
      <Link to="/cashbox" className="inline-flex items-center gap-1.5 self-start font-semibold text-brand-strong hover:underline"><ArrowRight aria-hidden="true" className="size-4" />الصندوق والمحاسبة</Link>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1"><h1 className="text-2xl font-bold">كشف حساب {s ? `«${s.fund}»` : 'الصندوق'}</h1><p className="text-muted">حركة نقد الصندوق في المدة برصيد جارٍ، ومن أين جاء المال وفيمَ ذهب.</p></div>
        <Field label="من">{(fid) => <Input id={fid} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="إلى">{(fid) => <Input id={fid} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Button variant="secondary" onClick={() => range(0)}>هذا الشهر</Button>
        <Button variant="secondary" onClick={() => range(1)}>الشهر الماضي</Button>
        <Button variant="secondary" onClick={() => { setFrom(''); setTo(''); }}>كل المدة</Button>
        <Button onClick={printSheet} disabled={!s}><Printer aria-hidden="true" className="size-4" />اطبع الكشف</Button>
      </div>
      {q.isPending && <Skeleton className="h-64 w-full" />}
      {q.error && <Alert>{q.error.message}</Alert>}
      {s && (
        <>
          <div className="flex flex-wrap items-start gap-5">
            <Shares title="مصادر الإيراد" groups={s.income} empty="لم يُقبض شيء في هذه المدة." />
            <Shares title="أبواب الصرف" groups={s.spending} empty="لم يُصرف شيء في هذه المدة." />
          </div>
          <Card className="print-sheet flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline gap-3 border-b-2 border-ink pb-2"><h2 className="flex-1 text-xl font-bold">كشف حساب «{s.fund}»</h2><span className="text-muted">{s.from ? <bdi>{formatDate(s.from)}</bdi> : 'من البداية'} — {s.to ? <bdi>{formatDate(s.to)}</bdi> : 'إلى اليوم'}</span></div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[['رصيد أول المدة', s.opening], ['دخل النقد', s.received], ['خرج منه', s.paid], ['رصيد آخر المدة', s.closing], ['في ذمم الموظفين الآن', s.custody]].map(([l, v]) => (
                <div key={l as string}><dt className="text-sm text-muted">{l}</dt><dd className="text-xl font-bold tabular-nums" data-testid={l === 'رصيد آخر المدة' ? 'closing' : undefined}>{formatNumber(v as number)}</dd></div>
              ))}
            </dl>
            {s.lines.length === 0 ? <p className="text-muted">لا حركة على نقد الصندوق في هذه المدة.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[46rem] border-collapse text-sm">
                  <thead><tr className="text-muted">{['التاريخ', 'السند', 'البيان', 'دخل', 'خرج', 'الرصيد'].map((h) => <th key={h} scope="col" className="border-b border-line p-2 text-start font-medium">{h}</th>)}</tr></thead>
                  <tbody>
                    <tr className="border-b border-line bg-ground"><td className="p-2" colSpan={5}>رصيد أول المدة</td><td className="p-2 font-semibold tabular-nums">{formatNumber(s.opening)}</td></tr>
                    {s.lines.map((l) => (
                      <tr key={l.id} className="border-b border-line last:border-0">
                        <td className="whitespace-nowrap p-2"><bdi>{formatDateTime(l.at)}</bdi></td>
                        <td className="p-2"><button type="button" className="font-semibold text-brand-strong underline tabular-nums" onClick={() => setVoucher(l.id)}><bdi>{l.no}</bdi></button></td>
                        <td className="p-2">{KIND_AR[l.kind] ?? l.kind}: {l.description}{l.party ? ` · ${l.party}` : ''}</td>
                        <td className="p-2 tabular-nums">{l.in ? formatNumber(l.in) : ''}</td>
                        <td className="p-2 tabular-nums">{l.out ? formatNumber(l.out) : ''}</td>
                        <td className="p-2 font-semibold tabular-nums">{formatNumber(l.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      <VoucherDialog id={voucher} onClose={() => setVoucher(null)} />
    </>
  );
}
