import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AgentDonations } from '../components/AgentDonations';
import { useState } from 'react';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';

interface Wh { id: string; name: string; pointId: string | null; main: boolean }
interface Stock { warehouses: Wh[]; pendingMoves: number; items: { id: string; name: string; unit: string; byWarehouse: Record<string, number>; main: number; atPoints: number; nearestExpiry: string | null }[] }
interface Move { id: string; kind: Kind | 'ADJUST'; status: 'POSTED' | 'PENDING' | 'REJECTED'; quantity: number; item: string; unit: string; from: string | null; to: string | null; by: string; note: string | null; source: string | null; campaign: string | null; createdAt: string }
type Kind = 'RECEIPT' | 'TRANSFER' | 'RETURN' | 'WASTE';
export interface Reconcile { campaign: string; item: string | null; unit?: string; shortage?: number; points: { pointId: string; point: string; needed: number; sent: number; delivered: number; returned: number; remaining: number; shortage: number }[] }

const KIND_AR = { RECEIPT: 'وارد', TRANSFER: 'تحويل', RETURN: 'راجع', WASTE: 'تالف', ADJUST: 'تسوية جرد' } as const;
const int = (v: string) => Number(v.replace(/\D/g, '')) || 0;

/** جدول المطابقة: ما خرج إلى النقطة = ما سُلِّم + ما رجع + ما بقي. */
export function ReconcileTable({ data }: { data: Reconcile }) {
  if (!data.item) return <p className="text-muted">برنامج هذه الحملة غير مربوط بصنف في المخزن، فلا مطابقة له.</p>;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] border-collapse text-sm">
          <thead><tr className="text-muted">{['النقطة', 'حاجتها', 'أُرسل', 'سُلِّم', 'رجع', 'باقٍ فيها', 'الفرق'].map((h) => <th key={h} scope="col" className="border-b border-line p-2 text-start font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {data.points.map((p) => (
              <tr key={p.pointId} className="border-b border-line last:border-0">
                <td className="p-2 font-semibold">{p.point}</td>
                {[p.needed, p.sent, p.delivered, p.returned, p.remaining].map((n, i) => <td key={i} className="p-2 tabular-nums">{formatNumber(n)}</td>)}
                <td className="p-2 font-bold">{p.shortage ? <span className="text-danger">{formatNumber(p.shortage)} ناقصة</span> : <span className="text-brand-strong">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.shortage ? <Alert><strong>{formatNumber(data.shortage)} {data.unit} سُلِّمت فوق ما أُرسل إلى نقاطها.</strong> إمّا تحويل لم يُسجَّل، وإمّا تسليم بلا بضاعة. يُراجَع مع أمين المخزن.</Alert>
        : <p className="text-sm text-muted">الصنف: {data.item}. لا فرق بين ما خرج وما سُلِّم.</p>}
    </>
  );
}

function MoveDialog({ kind, stock, onClose }: { kind: Kind | null; stock: Stock; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const main = stock.warehouses.find((w) => w.main)!;
  const pointWhs = stock.warehouses.filter((w) => !w.main);
  const [form, setForm] = useState({ itemId: '', other: '', quantity: '', expiry: '', source: '', note: '' });
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { kind, itemId: form.itemId, quantity: int(form.quantity), note: form.note.trim() || undefined };
      if (kind === 'RECEIPT') Object.assign(body, { toWarehouseId: main.id, expiry: form.expiry || undefined, source: form.source.trim() || undefined });
      if (kind === 'TRANSFER') Object.assign(body, { fromWarehouseId: main.id, toWarehouseId: form.other });
      if (kind === 'RETURN') Object.assign(body, { fromWarehouseId: form.other, toWarehouseId: main.id });
      if (kind === 'WASTE') Object.assign(body, { fromWarehouseId: form.other || main.id });
      return api<{ status: string }>('/inventory/moves', { method: 'POST', body });
    },
    onSuccess: (r) => {
      toast(r.status === 'PENDING' ? 'سُجّل التالف وينتظر اعتماد موظف آخر' : 'سُجّلت الحركة');
      queryClient.invalidateQueries({ queryKey: ['stock'] });
      queryClient.invalidateQueries({ queryKey: ['stock-moves'] });
      setForm({ itemId: '', other: '', quantity: '', expiry: '', source: '', note: '' });
      onClose();
    },
  });
  const needsOther = kind === 'TRANSFER' || kind === 'RETURN';
  const ok = !!form.itemId && int(form.quantity) > 0 && (!needsOther || !!form.other) && (kind !== 'WASTE' || form.note.trim().length >= 3);
  return (
    <Dialog open={kind !== null} title={kind ? { RECEIPT: 'تسجيل وارد إلى المخزن الرئيس', TRANSFER: 'تحويل إلى نقطة', RETURN: 'راجع من نقطة', WASTE: 'تسجيل تالف' }[kind] : ''} onClose={() => { save.reset(); onClose(); }}>
      {save.error && <Alert>{save.error.message}</Alert>}
      <Field label="الصنف">{(id) => <Select id={id} value={form.itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value })}><option value="">اختر الصنف</option>{stock.items.map((i) => <option key={i.id} value={i.id}>{i.name} (في الرئيس {formatNumber(i.main)})</option>)}</Select>}</Field>
      {(needsOther || kind === 'WASTE') && (
        <Field label={kind === 'TRANSFER' ? 'إلى مخزن النقطة' : kind === 'RETURN' ? 'من مخزن النقطة' : 'من مخزن'}>
          {(id) => <Select id={id} value={form.other} onChange={(e) => setForm({ ...form, other: e.target.value })}>{kind === 'WASTE' ? <option value="">المخزن الرئيس</option> : <option value="">اختر</option>}{pointWhs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}
        </Field>
      )}
      <Field label="الكمية">{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />}</Field>
      {kind === 'RECEIPT' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="تاريخ الصلاحية (إن وُجد)">{(id) => <Input id={id} type="date" value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value })} />}</Field>
          <Field label="المصدر (مورّد أو متبرع)">{(id) => <Input id={id} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />}</Field>
        </div>
      )}
      <Field label={kind === 'WASTE' ? 'سبب التلف (لازم)' : 'ملاحظة (اختيارية)'}>{(id) => <Input id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
      {kind === 'WASTE' && <p className="text-sm text-muted">التالف لا يُخصم من الرصيد حتى يعتمده موظف آخر.</p>}
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>إلغاء</Button>
        <Button disabled={!ok || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'جارٍ الحفظ…' : 'سجّل الحركة'}</Button>
      </div>
    </Dialog>
  );
}

export function Warehouse() {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const stock = useQuery({ queryKey: ['stock'], queryFn: () => api<Stock>('/inventory/stock') });
  const moves = useQuery({ queryKey: ['stock-moves'], queryFn: () => api<Move[]>('/inventory/moves') });
  const donations = useQuery({ queryKey: ['agent-donations', '?kind=IN_KIND&status=REPORTED'], queryFn: () => api<{ id: string }[]>('/agent-donations?kind=IN_KIND&status=REPORTED') });
  const [kind, setKind] = useState<Kind | null>(null);
  const [adding, setAdding] = useState(false);
  const [item, setItem] = useState({ name: '', unit: '' });
  const [deciding, setDeciding] = useState<{ move: Move; approve: boolean } | null>(null);
  const canKeep = user?.role === 'ADMIN' || user?.role === 'STOREKEEPER';
  const canApprove = canKeep || user?.role === 'DISTRIBUTION_MANAGER';
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ['stock'] }); queryClient.invalidateQueries({ queryKey: ['stock-moves'] }); };

  const addItem = useMutation({
    mutationFn: () => api('/inventory/items', { method: 'POST', body: { name: item.name.trim(), unit: item.unit.trim() } }),
    onSuccess: () => { toast('أُضيف الصنف'); setItem({ name: '', unit: '' }); setAdding(false); refresh(); },
  });
  const decide = useMutation({
    mutationFn: (note: string) => api(`/inventory/moves/${deciding!.move.id}/${deciding!.approve ? 'approve' : 'reject'}`, { method: 'POST', body: note ? { note } : {} }),
    onSuccess: () => { toast(deciding!.approve ? 'اعتُمدت الحركة وخُصمت من الرصيد' : 'رُفضت الحركة'); setDeciding(null); refresh(); },
  });

  if (stock.isPending) return <Skeleton className="h-48 w-full" />;
  if (stock.error) return <Alert>{stock.error.message}</Alert>;
  const s = stock.data;
  const pending = moves.data?.filter((m) => m.status === 'PENDING') ?? [];
  const soon = (d: string | null) => !!d && new Date(d).getTime() - Date.now() < 30 * 86400000;

  return (
    <>
      <PageHeader title="المخازن" description={`المخزن الرئيس و${s.warehouses.length - 1} مخازن في نقاط التوزيع.`}
        action={canKeep && (
          <div className="flex flex-wrap gap-2.5">
            <Button variant="secondary" onClick={() => setAdding(true)}>صنف جديد</Button>
            <Button variant="secondary" onClick={() => setKind('WASTE')}>تالف</Button>
            <Button variant="secondary" onClick={() => setKind('RETURN')}>راجع من نقطة</Button>
            <Button variant="secondary" onClick={() => setKind('TRANSFER')}>تحويل إلى نقطة</Button>
            <Button onClick={() => setKind('RECEIPT')}>تسجيل وارد</Button>
          </div>
        )} />

      {(donations.data?.length ?? 0) > 0 && (
        <Card className="flex flex-col gap-2 !border-2 !border-[#C8862A]">
          <h2 className="text-lg font-bold">تبرعات عينية بلّغ بها المتعهدون وتنتظر الاستلام ({donations.data!.length})</h2>
          <AgentDonations pendingOnly />
        </Card>
      )}

      {pending.length > 0 && (
        <Card className="flex flex-col gap-3 !border-2 !border-[#C8862A]">
          <h2 className="text-lg font-bold">حركات تنتظر الاعتماد ({pending.length})</h2>
          {pending.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-3 border-b border-line pb-2.5 last:border-0">
              <div className="min-w-0 flex-1"><strong>{KIND_AR[m.kind]}: {formatNumber(m.quantity)} {m.unit} {m.item}</strong><div className="text-sm text-muted">{m.from ? `من ${m.from}` : `إلى ${m.to}`} · {m.note} · سجّله {m.by}</div></div>
              {m.by === user?.username ? <Badge tone="warn">سجّلتَه أنت: يعتمده غيرك</Badge> : canApprove && (
                <><Button variant="danger" onClick={() => setDeciding({ move: m, approve: false })}>رفض</Button><Button onClick={() => setDeciding({ move: m, approve: true })}>اعتماد</Button></>
              )}
            </div>
          ))}
        </Card>
      )}

      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse">
            <thead><tr className="text-sm text-muted">
              <th scope="col" className="border-b border-line px-4 py-3 text-start font-medium">الصنف</th>
              {s.warehouses.map((w) => <th key={w.id} scope="col" className="border-b border-line px-4 py-3 text-start font-medium">{w.name}</th>)}
              <th scope="col" className="border-b border-line px-4 py-3 text-start font-medium">أقرب صلاحية</th>
            </tr></thead>
            <tbody>
              {s.items.length === 0 && <tr><td colSpan={s.warehouses.length + 2} className="px-4 py-10 text-center text-muted">لا أصناف بعد. أضف صنفاً ثم سجّل وارده.</td></tr>}
              {s.items.map((i) => (
                <tr key={i.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3"><strong>{i.name}</strong> <span className="text-sm text-muted">({i.unit})</span></td>
                  {s.warehouses.map((w) => <td key={w.id} className={`px-4 py-3 tabular-nums ${i.byWarehouse[w.id] < 0 ? 'font-bold text-danger' : ''}`}>{formatNumber(i.byWarehouse[w.id])}{i.byWarehouse[w.id] < 0 ? ' ناقصة' : ''}</td>)}
                  <td className="px-4 py-3">{i.nearestExpiry ? <Badge tone={soon(i.nearestExpiry) ? 'warn' : 'neutral'}>{formatDate(i.nearestExpiry)}</Badge> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">آخر الحركات</h2>
        {moves.data?.length === 0 && <p className="text-muted">لا حركات بعد.</p>}
        <ul className="flex flex-col">
          {moves.data?.filter((m) => m.status !== 'PENDING').slice(0, 20).map((m) => (
            <li key={m.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-2.5 last:border-0">
              <strong className="min-w-16">{KIND_AR[m.kind]}</strong>
              <span className="min-w-0 flex-1">{formatNumber(m.quantity)} {m.unit} {m.item}{m.from ? ` من ${m.from}` : ''}{m.to ? ` إلى ${m.to}` : ''}{m.source ? ` · ${m.source}` : ''}{m.campaign ? ` · ${m.campaign}` : ''}{m.status === 'REJECTED' ? ' · مرفوضة' : ''}</span>
              <span className="text-sm text-muted">{m.by} · {formatDateTime(m.createdAt)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <MoveDialog kind={kind} stock={s} onClose={() => setKind(null)} />
      <Dialog open={adding} title="صنف جديد" onClose={() => { addItem.reset(); setAdding(false); }}>
        {addItem.error && <Alert>{addItem.error.message}</Alert>}
        <Field label="اسم الصنف">{(id) => <Input id={id} value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} />}</Field>
        <Field label="الوحدة" hint="سلة، كيس، عبوة، قطعة…">{(id) => <Input id={id} value={item.unit} onChange={(e) => setItem({ ...item, unit: e.target.value })} />}</Field>
        <div className="flex flex-wrap justify-end gap-3"><Button variant="secondary" onClick={() => setAdding(false)}>إلغاء</Button><Button disabled={item.name.trim().length < 2 || !item.unit.trim() || addItem.isPending} onClick={() => addItem.mutate()}>أضف الصنف</Button></div>
      </Dialog>
      <ReasonDialog open={deciding !== null} danger={deciding?.approve === false} required={deciding?.approve === false}
        title={deciding?.approve ? 'اعتماد الحركة' : 'رفض الحركة'} confirmLabel={deciding?.approve ? 'اعتماد الحركة' : 'رفض الحركة'}
        pending={decide.isPending} error={decide.error?.message} onClose={() => { decide.reset(); setDeciding(null); }} onConfirm={(note) => decide.mutate(note)}>
        {deciding && <p>{KIND_AR[deciding.move.kind]}: <strong>{formatNumber(deciding.move.quantity)} {deciding.move.unit} {deciding.move.item}</strong>. {deciding.approve ? 'يُخصم من الرصيد فور الاعتماد.' : 'يبقى الرصيد كما هو.'}</p>}
      </ReasonDialog>
    </>
  );
}
