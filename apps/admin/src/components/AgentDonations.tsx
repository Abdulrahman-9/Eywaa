import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatNumber, digits } from '../lib/format';
import { ReasonDialog } from './ReasonDialog';
import { useToast } from './toast';
import { Alert, Badge, Button, Dialog, Field, Input, Select } from './ui';
import { VoucherDialog } from './Voucher';

export interface Donation {
  id: string; no: number; kind: 'CASH' | 'IN_KIND'; agentId: string; agentName: string; donorName: string; donorPhone: string | null; purpose: string | null; note: string | null;
  status: 'REPORTED' | 'RECEIVED' | 'CANCELLED'; reportedAt: string; amount: number | null; fund: string | null; entryId: string | null; entryNo: string | null;
  itemText: string | null; quantity: number | null; unit: string | null; receivedQuantity: number | null; receivedItem: string | null; warehouse: string | null;
  receivedBy: string | null; receivedAt: string | null; closeNote: string | null;
}
interface StockLite { warehouses: { id: string; name: string; main: boolean }[]; items: { id: string; name: string; unit: string }[] }

const STATUS: Record<Donation['status'], [string, 'ok' | 'warn' | 'neutral']> = { REPORTED: ['ينتظر الاستلام', 'warn'], RECEIVED: ['استُلم', 'ok'], CANCELLED: ['أُلغي', 'neutral'] };
const LEDGER_READERS = ['ADMIN', 'ACCOUNTANT', 'DISTRIBUTION_MANAGER', 'AUDITOR'];

export const donationWhat = (d: Donation) => (d.kind === 'CASH' ? `${formatNumber(d.amount ?? 0)} دينار` : `${formatNumber(d.quantity ?? 0)} ${d.unit ?? ''} ${d.itemText ?? ''}`.replace(/\s+/g, ' '));

/** تبرعات سجّلها المتعهدون: النقدي بسنده، والعيني ببلاغه حتى يستلمه أمين المخزن. */
export function AgentDonations({ agentId, pendingOnly, rows }: { agentId?: string; pendingOnly?: boolean; rows?: Donation[] }) {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const role = user?.role ?? '';
  const canReceive = role === 'ADMIN' || role === 'STOREKEEPER';
  const canCancel = canReceive || role === 'DISTRIBUTION_MANAGER';
  const query = pendingOnly ? '?kind=IN_KIND&status=REPORTED' : agentId ? `?agentId=${agentId}` : '';
  const list = useQuery({ queryKey: ['agent-donations', query], queryFn: () => api<Donation[]>(`/agent-donations${query}`), enabled: !rows });
  const stock = useQuery({ queryKey: ['stock'], queryFn: () => api<StockLite>('/inventory/stock'), enabled: canReceive });
  const [receiving, setReceiving] = useState<Donation | null>(null);
  const [cancelling, setCancelling] = useState<Donation | null>(null);
  const [voucher, setVoucher] = useState<string | null>(null);
  const [f, setF] = useState({ itemId: '', warehouseId: '', quantity: '', expiry: '', note: '' });
  useEffect(() => {
    if (receiving) setF({ itemId: '', warehouseId: stock.data?.warehouses.find((w) => w.main)?.id ?? '', quantity: String(receiving.quantity ?? ''), expiry: '', note: '' });
    // يُملأ عند فتح النافذة، لا عند كل تحديث للمخزون في الخلفية.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiving]);
  const refresh = () => { for (const key of ['agent-donations', 'agents', 'agent', 'stock', 'stock-moves']) queryClient.invalidateQueries({ queryKey: [key] }); };
  const receive = useMutation({
    mutationFn: () => api(`/agent-donations/${receiving!.id}/receive`, { method: 'POST', body: { itemId: f.itemId, warehouseId: f.warehouseId, quantity: Number(f.quantity), ...(f.expiry ? { expiry: f.expiry } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}) } }),
    onSuccess: () => { toast('دخل التبرع المخزن وارداً باسم المتبرع'); setReceiving(null); refresh(); },
  });
  const cancel = useMutation({
    mutationFn: (note: string) => api(`/agent-donations/${cancelling!.id}/cancel`, { method: 'POST', body: { note } }),
    onSuccess: () => { toast('أُلغي البلاغ'); setCancelling(null); refresh(); },
  });
  const data = rows ?? list.data ?? [];
  const differs = !!receiving && Number(f.quantity) !== receiving.quantity;

  return (
    <>
      {list.error && <Alert>{list.error.message}</Alert>}
      {!list.isPending && data.length === 0 && <p className="text-muted">{pendingOnly ? 'لا تبرع عيني ينتظر الاستلام.' : 'لم يُسجَّل تبرع بعد.'}</p>}
      <ul className="flex flex-col">
        {data.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line py-3 last:border-0" data-testid="donation">
            <div className="min-w-0 flex-1">
              <strong>{donationWhat(d)}</strong> <span className="text-muted">من</span> <strong>{d.donorName}</strong>
              <div className="text-sm text-muted">
                {d.kind === 'CASH' ? 'نقدي' : 'عيني'} رقم <bdi>{d.no}</bdi>{!agentId && <> · بيد {d.agentName}</>} · <bdi>{formatDateTime(d.reportedAt)}</bdi>
                {d.donorPhone && <> · <bdi dir="ltr">{d.donorPhone}</bdi></>}{d.purpose && <> · {d.purpose}</>}
                {d.kind === 'CASH' && d.fund && <> · {d.fund}</>}
                {d.kind === 'IN_KIND' && d.status === 'RECEIVED' && <> · استلمه {d.receivedBy}: {formatNumber(d.receivedQuantity ?? 0)} {d.receivedItem} في {d.warehouse}</>}
                {d.closeNote && <> · {d.closeNote}</>}
              </div>
            </div>
            {d.kind === 'CASH' && d.entryId && (LEDGER_READERS.includes(role)
              ? <button type="button" className="font-semibold text-brand-strong underline tabular-nums" onClick={() => setVoucher(d.entryId)}><bdi>{d.entryNo}</bdi></button>
              : <bdi className="tabular-nums text-muted">{d.entryNo}</bdi>)}
            <Badge tone={STATUS[d.status][1]}>{d.kind === 'CASH' && d.status === 'RECEIVED' ? 'في ذمة المتعهد أو سُلّم' : STATUS[d.status][0]}</Badge>
            {d.kind === 'IN_KIND' && d.status === 'REPORTED' && (
              <>
                {canCancel && <Button variant="ghost" onClick={() => { cancel.reset(); setCancelling(d); }}>ألغِ البلاغ</Button>}
                {canReceive && <Button onClick={() => { receive.reset(); setReceiving(d); }}>استلمه في المخزن</Button>}
              </>
            )}
          </li>
        ))}
      </ul>

      <Dialog open={receiving !== null} title="استلام تبرع عيني" onClose={() => setReceiving(null)}>
        {receiving && (
          <>
            <p>بلّغ <strong>{receiving.agentName}</strong> بتبرع من <strong>{receiving.donorName}</strong>: <strong>{donationWhat(receiving)}</strong>. سجّل ما وجدتَه أنت.</p>
            {receive.error && <Alert>{receive.error.message}</Alert>}
            <Field label="الصنف في المخزن" hint="إن لم يكن الصنف موجوداً فأضفه من صفحة المخازن أولاً">
              {(id) => <Select id={id} value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}><option value="">اختر الصنف</option>{stock.data?.items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}</Select>}
            </Field>
            <Field label="يدخل إلى">{(id) => <Select id={id} value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}>{stock.data?.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="الكمية المستلَمة">{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={f.quantity} onChange={(e) => setF({ ...f, quantity: digits(e.target.value) })} />}</Field>
              <Field label="الصلاحية (إن وُجدت)">{(id) => <Input id={id} type="date" value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} />}</Field>
            </div>
            <Field label={differs ? 'سبب الفرق (لازم)' : 'ملاحظة'} error={differs && !f.note.trim() ? `المبلَّغ ${receiving.quantity} والمستلَم ${f.quantity || 0}` : undefined}>
              {(id) => <Input id={id} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}
            </Field>
            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="secondary" onClick={() => setReceiving(null)}>إلغاء</Button>
              <Button loading={receive.isPending} disabled={!f.itemId || !f.warehouseId || !Number(f.quantity) || (differs && !f.note.trim())} onClick={() => receive.mutate()}>أدخله المخزن</Button>
            </div>
          </>
        )}
      </Dialog>
      <ReasonDialog open={cancelling !== null} title="إلغاء بلاغ تبرع عيني" confirmLabel="ألغِ البلاغ" danger pending={cancel.isPending} error={cancel.error?.message}
        onClose={() => setCancelling(null)} onConfirm={(note) => cancel.mutate(note)}>
        {cancelling && <p>{donationWhat(cancelling)} من {cancelling.donorName}، بلّغ به {cancelling.agentName}. يُلغى إن لم يصل أو سُجّل خطأً.</p>}
      </ReasonDialog>
      <VoucherDialog id={voucher} onClose={() => setVoucher(null)} />
    </>
  );
}
