import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { api } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';
import { printSheet } from '../lib/print';
import { amountInWords } from '../lib/tafqeet';
import { Alert, Badge, Button, Dialog, Skeleton } from './ui';

interface VoucherData {
  id: string; no: string; kind: string; status: 'POSTED' | 'PENDING' | 'REJECTED'; fund: string; amount: number; description: string; party: string | null; category: string | null;
  at: string; createdBy: string; decidedBy: string | null; decidedAt: string | null; custodyOf: string | null; lines: { account: string; debit: number; credit: number }[];
}

export const KIND_AR: Record<string, string> = {
  RECEIPT: 'سند قبض', PAYMENT: 'سند صرف', CUSTODY_ISSUE: 'تسليم عهدة', CUSTODY_RETURN: 'استلام ذمة', DISBURSEMENT: 'صرف لمستحق', SHORTAGE: 'عجز عهدة', OVERAGE: 'زيادة عهدة', REVERSAL: 'قيد عكس',
};
/** أبواب القبض والصرف التي يضعها النظام من نفسه؛ ما سواها يكتبه المحاسب نصاً. */
export const CATEGORY_AR: Record<string, string> = {
  BOX: 'صناديق التبرعات', AGENT_DONATION: 'تبرعات بيد المتعهدين', DONOR: 'متبرعون مسجَّلون', DIRECT: 'قبض مباشر', DISBURSEMENT: 'صرف لمستحقين',
};
export const categoryLabel = (c: string | null) => (c ? CATEGORY_AR[c] ?? c : '—');

const account = (a: string, v: VoucherData) =>
  a === 'CASH' ? 'نقد الصندوق' : a === 'INCOME' ? 'الإيرادات' : a.startsWith('CUSTODY:') ? `ذمة ${v.custodyOf ?? 'موظف'}` : a.startsWith('EXPENSE:') ? `مصروف: ${categoryLabel(a.slice(8))}` : a;

/** سند واحد كما يُطبع ويُوقَّع: رقمه وتاريخه ومبلغه رقماً وكتابةً وطرفا قيده. */
export function VoucherDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['voucher', id], queryFn: () => api<VoucherData>(`/accounting/entries/${id}`), enabled: !!id });
  const v = q.data;
  return (
    <Dialog open={!!id} title={v ? `${KIND_AR[v.kind] ?? v.kind} ${v.no}` : 'سند'} onClose={onClose} wide>
      {q.isPending && <Skeleton className="h-64 w-full" />}
      {q.error && <Alert>{q.error.message}</Alert>}
      {v && (
        <>
          <div className="print-sheet flex flex-col gap-4 rounded-xl border border-line-strong p-5" data-testid="voucher">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-ink pb-3">
              <div><div className="text-2xl font-bold">{KIND_AR[v.kind] ?? v.kind}</div><div className="text-muted">{v.fund}</div></div>
              <div className="text-end"><div className="text-xl font-bold tabular-nums"><bdi>{v.no}</bdi></div><div className="text-sm text-muted"><bdi>{formatDateTime(v.at)}</bdi></div></div>
            </div>
            {v.status !== 'POSTED' && <Badge tone={v.status === 'PENDING' ? 'warn' : 'danger'}>{v.status === 'PENDING' ? 'لم يُعتمد بعد: لا يُعمل به' : 'مرفوض'}</Badge>}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5">
              {v.party && <><dt className="text-muted">{v.kind === 'RECEIPT' ? 'استلمنا من' : v.kind === 'PAYMENT' ? 'صُرف إلى' : 'الطرف'}</dt><dd className="font-semibold">{v.party}</dd></>}
              <dt className="text-muted">المبلغ</dt>
              <dd><strong className="text-2xl tabular-nums">{formatNumber(v.amount)}</strong> دينار<div className="text-sm">فقط {amountInWords(v.amount)}</div></dd>
              <dt className="text-muted">البيان</dt><dd>{v.description}</dd>
              {v.category && <><dt className="text-muted">الباب</dt><dd>{categoryLabel(v.category)}</dd></>}
            </dl>
            <table className="w-full border-collapse text-sm">
              <thead><tr className="text-muted">{['الحساب', 'مدين', 'دائن'].map((h) => <th key={h} scope="col" className="border-b border-line p-1.5 text-start font-medium">{h}</th>)}</tr></thead>
              <tbody>{v.lines.map((l) => <tr key={l.account} className="border-b border-line last:border-0"><td className="p-1.5">{account(l.account, v)}</td><td className="p-1.5 tabular-nums">{l.debit ? formatNumber(l.debit) : ''}</td><td className="p-1.5 tabular-nums">{l.credit ? formatNumber(l.credit) : ''}</td></tr>)}</tbody>
            </table>
            <div className="grid grid-cols-3 gap-4 pt-6 text-sm">
              {[['حرّره', v.createdBy], ['اعتمده', v.decidedBy ?? ''], [v.kind === 'PAYMENT' ? 'المستلم' : 'المسلِّم', '']].map(([label, name]) => (
                <div key={label} className="flex flex-col gap-6"><span className="text-muted">{label}: <strong className="text-ink">{name}</strong></span><span className="border-t border-ink pt-1 text-muted">التوقيع</span></div>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-3"><Button variant="secondary" onClick={onClose}>أغلق</Button><Button onClick={printSheet}><Printer aria-hidden="true" className="size-4" />اطبع السند</Button></div>
        </>
      )}
    </Dialog>
  );
}
