import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';
import { ReasonDialog } from './ReasonDialog';
import { useToast } from './toast';
import { Alert, Badge, Button, Card, Field, Input, Select } from './ui';

interface Row {
  entitlementId: string; familyId: string; familyNo: string; headName: string | null; hasPhone: boolean; status: 'PENDING' | 'DELIVERED' | 'CANCELLED'; quantity: number; point: string; pickedBy: 'RULE' | 'NOMINATED' | 'MANUAL';
  deliveredAt: string | null; deliveredPoint: string | null; receiver: 'HEAD' | 'PROXY' | null; receiverName: string | null; mode: string | null; by: string | null; hasProof: boolean;
}
const PAGE = 50;
const MODE: Record<string, string> = { ONLINE: 'متصل', OFFLINE: 'دون اتصال', TRANSFER: 'حوالة أو محفظة' };

/**
 * عوائل الحملة بحال كلٍّ منها: من استلم ومتى وممن، ومن لم يستلم. للاستعلام عن حملة جارية أو سابقة.
 * والحملة مسودة: تُضاف عائلة برقمها وتُحذف أخرى بسببها.
 */
export function CampaignFamilies({ campaignId, campaignStatus, unit, points, canManage, canExport }: { campaignId: string; campaignStatus: string; unit: string; points: { id: string; name: string }[]; canManage: boolean; canExport: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [pointId, setPointId] = useState('');
  const [page, setPage] = useState(0);
  const [addNo, setAddNo] = useState('');
  const [removing, setRemoving] = useState<Row | null>(null);
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(0); }, 300); return () => clearTimeout(t); }, [q]);
  const draft = campaignStatus === 'DRAFT';
  const live = campaignStatus === 'ACTIVE' || campaignStatus === 'CLOSED';
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (debounced) params.set('q', debounced);
  if (status) params.set('status', status);
  if (pointId) params.set('pointId', pointId);
  const list = useQuery({
    queryKey: ['campaign', campaignId, 'families', debounced, status, pointId, page],
    queryFn: () => api<{ total: number; rows: Row[] }>(`/campaigns/${campaignId}/families?${params}`),
    placeholderData: keepPreviousData, refetchInterval: campaignStatus === 'ACTIVE' ? 20_000 : false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['campaign', campaignId] });
  const add = useMutation({
    mutationFn: () => api(`/campaigns/${campaignId}/families`, { method: 'POST', body: { familyNo: addNo.trim() } }),
    onSuccess: () => { toast(`أُضيفت العائلة ${addNo.trim()}`); setAddNo(''); refresh(); },
  });
  const remove = useMutation({
    mutationFn: (note: string) => api(`/campaigns/${campaignId}/families/${removing!.entitlementId}`, { method: 'DELETE', body: { note } }),
    onSuccess: () => { toast('حُذفت العائلة من الحملة'); setRemoving(null); refresh(); },
  });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const label = (r: Row) => (r.status === 'DELIVERED' ? ['استلمت', 'ok'] : r.status === 'CANCELLED' ? [campaignStatus === 'CLOSED' ? 'لم تستلم' : 'مُلغى', 'danger'] : [live ? 'لم تستلم بعد' : 'في الحملة', 'neutral']) as [string, 'ok' | 'danger' | 'neutral'];

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 flex-1 text-lg font-bold">عوائل الحملة</h2>
        {live && canExport && <Button variant="secondary" onClick={() => void download(`/reports/campaign/${campaignId}.csv`, 'كشف-التسليم.csv').catch((e) => toast(e.message, 'error'))}>نزّل كشف التسليم</Button>}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-[2]"><Field label="ابحث في عوائل الحملة">{(id) => <Input id={id} type="search" placeholder="رقم العائلة أو اسم رب الأسرة" value={q} onChange={(e) => setQ(e.target.value)} />}</Field></div>
        {live && (
          <div className="min-w-40 flex-1">
            <Field label="حال الاستلام">
              {(id) => <Select id={id} value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}><option value="">الكل</option><option value="DELIVERED">استلمت</option><option value={campaignStatus === 'CLOSED' ? 'CANCELLED' : 'PENDING'}>لم تستلم</option></Select>}
            </Field>
          </div>
        )}
        {points.length > 1 && (
          <div className="min-w-40 flex-1"><Field label="النقطة">{(id) => <Select id={id} value={pointId} onChange={(e) => { setPointId(e.target.value); setPage(0); }}><option value="">الكل</option>{points.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field></div>
        )}
      </div>
      {draft && canManage && (
        <div className="flex max-w-xl flex-wrap items-end gap-2 rounded-lg bg-ground p-3">
          <div className="min-w-48 flex-1"><Field label="أضف عائلة برقمها" hint="يلزم أن تستحق البرنامج. والحملة مسودة فقط.">{(id) => <Input id={id} inputMode="numeric" dir="ltr" value={addNo} onChange={(e) => setAddNo(e.target.value)} />}</Field></div>
          <Button variant="secondary" disabled={addNo.trim().length < 5 || add.isPending} onClick={() => add.mutate()}>أضف العائلة</Button>
        </div>
      )}
      {(list.error || add.error) && <Alert>{(list.error ?? add.error)!.message}</Alert>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <thead><tr className="text-muted">{['رقم العائلة', 'رب الأسرة', `المقدار (${unit})`, 'النقطة', 'الحال', ''].map((h, i) => <th key={i} scope="col" className="border-b border-line p-2 text-start font-medium">{h || <span className="sr-only">إجراء</span>}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.entitlementId} className="border-b border-line align-top last:border-0">
                <td className="p-2 font-semibold tabular-nums"><Link to={`/families/${r.familyId}`} className="text-brand-strong underline">{r.familyNo}</Link></td>
                <td className="p-2">{r.headName ?? '—'}{r.pickedBy !== 'RULE' && <> <Badge tone="info">{r.pickedBy === 'NOMINATED' ? 'بالترشيح' : 'باليد'}</Badge></>}{!r.hasPhone && <div className="text-warn-ink">بلا هاتف: لا تصلها دعوة</div>}</td>
                <td className="p-2 tabular-nums">{formatNumber(r.quantity)}</td>
                <td className="p-2">{r.point}</td>
                <td className="p-2">
                  <Badge tone={label(r)[1]}>{label(r)[0]}</Badge>
                  {r.status === 'DELIVERED' && r.deliveredAt && (
                    <div className="mt-1 text-muted">
                      <bdi>{formatDateTime(r.deliveredAt)}</bdi> · {r.receiver === 'PROXY' ? 'الوكيل' : 'رب الأسرة'} {r.receiverName}
                      <br />{[r.deliveredPoint, r.mode && MODE[r.mode], r.by && `سلّمها ${r.by}`, r.hasProof && 'بصورة'].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </td>
                <td className="p-2 text-end">{draft && canManage && <Button variant="danger" className="min-h-9 px-3" onClick={() => { remove.reset(); setRemoving(r); }}>احذف</Button>}</td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-muted">لا عائلة تطابق البحث.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span>{total ? `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} من ${formatNumber(total)}` : '0'}</span>
        <div className="ms-auto flex gap-2">
          <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>السابق</Button>
          <Button variant="secondary" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>التالي</Button>
        </div>
      </div>
      <ReasonDialog open={!!removing} title={`حذف العائلة ${removing?.familyNo ?? ''} من الحملة`} confirmLabel="احذفها من الحملة" danger pending={remove.isPending} error={remove.error?.message}
        onClose={() => setRemoving(null)} onConfirm={(note) => remove.mutate(note)}>
        <p>{removing?.headName}. لا تُحذف من النظام؛ تخرج من هذه الحملة وحدها، ويُحفظ السبب باسمك.</p>
      </ReasonDialog>
    </Card>
  );
}
