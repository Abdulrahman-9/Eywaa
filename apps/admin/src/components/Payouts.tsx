import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatNumber } from '../lib/format';
import { ReasonDialog } from './ReasonDialog';
import { useToast } from './toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Select } from './ui';

interface Batch {
  id: string; no: number; method: 'TRANSFER' | 'WALLET'; provider: string; status: 'PENDING_APPROVAL' | 'PAID' | 'REJECTED';
  total: number; items: number; paidTotal: number | null; paidItems: number | null; reference: string | null;
  createdBy: string; createdAt: string; decidedBy: string | null; decisionNote: string | null;
}
interface Candidate { entitlementId: string; familyNo: string; headName: string; phone: string | null; amount: number; point: string }

const METHOD = { WALLET: 'محفظة إلكترونية', TRANSFER: 'حوالة' } as const;
const STATUS = { PENDING_APPROVAL: ['ينتظر التنفيذ والاعتماد', 'warn'], PAID: ['دُفع', 'ok'], REJECTED: ['مرفوض', 'danger'] } as const;
const MAKERS = ['ADMIN', 'ACCOUNTANT', 'DISTRIBUTION_MANAGER'];
const APPROVERS = ['ADMIN', 'ACCOUNTANT'];
export const PAYOUT_READERS = [...MAKERS, 'AUDITOR'];

/** الصرف بالحوالة والمحفظة لحملة مالية: كشف يُنشأ، يُنفَّذ خارج النظام، ثم يعتمده موظف آخر بمرجعه. */
export function Payouts({ campaignId, active }: { campaignId: string; active: boolean }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [approving, setApproving] = useState<Batch | null>(null);
  const [rejecting, setRejecting] = useState<Batch | null>(null);
  const [reference, setReference] = useState('');
  const role = user?.role ?? '';
  const batches = useQuery({ queryKey: ['payouts', campaignId], queryFn: () => api<Batch[]>(`/campaigns/${campaignId}/payouts`) });
  const refresh = () => { for (const key of ['payouts', 'campaign', 'payout-candidates']) qc.invalidateQueries({ queryKey: [key] }); };

  const approve = useMutation({
    mutationFn: () => api<Batch>(`/payouts/${approving!.id}/approve`, { method: 'POST', body: { reference: reference.trim() } }),
    onSuccess: (b) => { toast(`اعتُمد الكشف ${b.no}: ${b.paidItems} عائلة، ${formatNumber(b.paidTotal ?? 0)} دينار`); setApproving(null); refresh(); },
  });
  const reject = useMutation({
    mutationFn: (note: string) => api(`/payouts/${rejecting!.id}/reject`, { method: 'POST', body: { note } }),
    onSuccess: () => { toast('رُفض الكشف وتحرّر أصحابه'); setRejecting(null); refresh(); },
  });

  if (!active && !batches.data?.length) return null;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold">الدفع بالحوالة والمحفظة</h2>
          <p className="text-sm text-muted">لمن لا يحضر إلى النقطة. من دخل كشفاً لا يُصرف له نقداً حتى يُفصل فيه.</p>
        </div>
        {active && MAKERS.includes(role) && <Button variant="secondary" onClick={() => setCreating(true)}>كشف دفع جديد</Button>}
      </div>
      {batches.error && <Alert>{batches.error.message}</Alert>}
      {batches.data?.length === 0 && <p className="text-muted">لا كشوف دفع لهذه الحملة.</p>}
      {batches.data?.map((b) => {
        const mine = b.createdBy === user?.username;
        const pending = b.status === 'PENDING_APPROVAL';
        return (
          <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-4 py-3">
            <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2"><strong>كشف {b.no}</strong><span>{METHOD[b.method]} · {b.provider}</span><Badge tone={STATUS[b.status][1]}>{STATUS[b.status][0]}</Badge></div>
              <span className="tabular-nums">
                {b.status === 'PAID' ? `${b.paidItems} عائلة · ${formatNumber(b.paidTotal ?? 0)} دينار · المرجع ${b.reference}` : `${b.items} عائلة · ${formatNumber(b.total)} دينار`}
              </span>
              {b.status === 'PAID' && b.paidItems !== b.items && <span className="text-sm text-warn-ink">{b.items - (b.paidItems ?? 0)} لم يُدفع له: استلم نقداً قبل الاعتماد أو أُلغي استحقاقه.</span>}
              {b.status === 'REJECTED' && <span className="text-sm text-danger">{b.decisionNote}</span>}
              <span className="text-sm text-muted">أنشأه {b.createdBy} · {formatDateTime(b.createdAt)}{b.decidedBy && ` · فصل فيه ${b.decidedBy}`}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {MAKERS.includes(role) && b.status !== 'REJECTED' && <Button variant="secondary" onClick={() => void download(`/payouts/${b.id}/file.csv`, `كشف-دفع-${b.no}.csv`).catch((e) => toast(e.message, 'error'))}>نزّل ملف الدفع</Button>}
              {pending && MAKERS.includes(role) && <Button variant="danger" onClick={() => setRejecting(b)}>رفض</Button>}
              {pending && APPROVERS.includes(role) && (mine ? <Badge tone="warn">كشفك: يعتمده غيرك</Badge> : <Button onClick={() => { setReference(''); approve.reset(); setApproving(b); }}>اعتماد بعد التنفيذ</Button>)}
            </div>
          </div>
        );
      })}

      {creating && <NewPayout campaignId={campaignId} onClose={() => setCreating(false)} onDone={(b) => { toast(`أُنشئ الكشف ${b.no}. نزّل ملفه ونفّذ الدفع، ثم يعتمده موظف آخر.`); setCreating(false); refresh(); }} />}

      <Dialog open={!!approving} title={`اعتماد كشف الدفع ${approving?.no ?? ''}`} onClose={() => setApproving(null)}>
        {approving && (
          <>
            <p><strong>{approving.items} عائلة · {formatNumber(approving.total)} دينار</strong> عبر {approving.provider}.</p>
            <Alert tone="warn">اعتمد بعد أن يُنفَّذ الدفع فعلاً. بالاعتماد تُعدّ هذه العوائل مستلِمة، ويُقيَّد المبلغ على الصندوق، وتصل كل عائلة رسالة بالتحويل.</Alert>
            {approve.error && <Alert>{approve.error.message}</Alert>}
            <Field label="مرجع التنفيذ" hint="رقم العملية من شركة المحفظة أو وصل مكتب الحوالة.">
              {(id) => <Input id={id} dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} />}
            </Field>
            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="secondary" onClick={() => setApproving(null)}>إلغاء</Button>
              <Button disabled={reference.trim().length < 3 || approve.isPending} onClick={() => approve.mutate()}>{approve.isPending ? 'جارٍ الاعتماد…' : 'اعتمد الكشف'}</Button>
            </div>
          </>
        )}
      </Dialog>
      <ReasonDialog open={!!rejecting} title={`رفض كشف الدفع ${rejecting?.no ?? ''}`} confirmLabel="ارفض الكشف" danger pending={reject.isPending} error={reject.error?.message}
        onClose={() => { reject.reset(); setRejecting(null); }} onConfirm={(note) => reject.mutate(note)}>
        <p>يتحرر أصحابه: يُصرف لهم نقداً بالرمز، أو يدخلون كشفاً آخر. لا تُرفض كشفاً نُفّذ دفعه.</p>
      </ReasonDialog>
    </Card>
  );
}

function NewPayout({ campaignId, onClose, onDone }: { campaignId: string; onClose: () => void; onDone: (b: Batch) => void }) {
  const [method, setMethod] = useState<'WALLET' | 'TRANSFER'>('WALLET');
  const [provider, setProvider] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const candidates = useQuery({ queryKey: ['payout-candidates', campaignId], queryFn: () => api<Candidate[]>(`/campaigns/${campaignId}/payout-candidates`) });
  const payable = (candidates.data ?? []).filter((c) => c.phone);
  const noPhone = (candidates.data?.length ?? 0) - payable.length;
  // لا يُختار أحد سلفاً: من يُحوَّل له يُعيَّن بالاسم، فلا يدخل الكشفَ من سيحضر إلى النقطة.
  // عند تحديث القائمة في الخلفية يبقى ما اختاره المحاسب، ويسقط منه من خرج من القائمة فقط (استلم في الأثناء).
  useEffect(() => { setPicked((old) => new Set([...old].filter((id) => candidates.data?.some((c) => c.entitlementId === id && c.phone)))); }, [candidates.data]);
  const total = payable.filter((c) => picked.has(c.entitlementId)).reduce((s, c) => s + c.amount, 0);
  const create = useMutation({
    mutationFn: () => api<Batch>('/payouts', { method: 'POST', body: { campaignId, method, provider: provider.trim(), entitlementIds: [...picked] } }),
    onSuccess: onDone,
  });
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Dialog open title="كشف دفع جديد" onClose={onClose}>
      {(candidates.error || create.error) && <Alert>{(candidates.error ?? create.error)!.message}</Alert>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
        <Field label="طريقة الدفع">
          {(id) => <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as 'WALLET' | 'TRANSFER')}><option value="WALLET">محفظة إلكترونية</option><option value="TRANSFER">حوالة</option></Select>}
        </Field>
        <Field label={method === 'WALLET' ? 'شركة المحفظة' : 'مكتب الحوالة أو المصرف'}>
          {(id) => <Input id={id} value={provider} onChange={(e) => setProvider(e.target.value)} placeholder={method === 'WALLET' ? 'مثال: زين كاش' : 'مثال: مكتب الصيرفة في السوق'} />}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <strong>اختر من يُحوَّل له</strong>
        <span className="text-sm text-muted">{method === 'WALLET' ? 'رقم الهاتف هو رقم المحفظة.' : 'برقم الهاتف يُعرَّف المستلم عند المكتب.'}</span>
        <button type="button" className="ms-auto font-semibold text-brand-strong underline" onClick={() => setPicked(picked.size === payable.length ? new Set() : new Set(payable.map((c) => c.entitlementId)))}>{picked.size === payable.length && payable.length ? 'ألغِ الكل' : 'اختر الكل'}</button>
      </div>
      <div className="max-h-72 overflow-y-auto rounded-lg border border-line">
        {payable.map((c) => (
          <label key={c.entitlementId} className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-line px-3 py-2 last:border-0 hover:bg-ground">
            <input type="checkbox" className="size-5" checked={picked.has(c.entitlementId)} onChange={() => toggle(c.entitlementId)} />
            <span className="min-w-0 flex-1"><span className="font-semibold">{c.headName}</span> <span className="text-sm text-muted tabular-nums">{c.familyNo}</span></span>
            <span dir="ltr" className="text-sm tabular-nums text-muted">{c.phone}</span>
            <span className="tabular-nums">{formatNumber(c.amount)}</span>
          </label>
        ))}
        {candidates.isSuccess && payable.length === 0 && <p className="px-3 py-6 text-center text-muted">لم يبقَ في الحملة من يصلح لكشف دفع.</p>}
      </div>
      {noPhone > 0 && <p className="text-sm text-warn-ink">{noPhone} عائلة بلا رقم هاتف: لا تدخل كشف دفع، وتستلم نقداً بالرمز.</p>}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="me-auto font-semibold tabular-nums">{picked.size} عائلة · {formatNumber(total)} دينار</span>
        <Button variant="secondary" onClick={onClose}>إلغاء</Button>
        <Button disabled={picked.size === 0 || provider.trim().length < 2 || create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'جارٍ الإنشاء…' : 'أنشئ الكشف'}</Button>
      </div>
    </Dialog>
  );
}
