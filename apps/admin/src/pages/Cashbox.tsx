import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatNumber } from '../lib/format';
import type { Program } from './Programs';
import type { Donor } from './Reports';

export interface Fund { id: string; name: string; note: string | null; programId: string | null; program: string | null; cash: number; custody: number; reserved: number; available: number }
interface Summary { funds: Fund[]; receivedThisMonth: number; spentThisMonth: number; pendingEntries: number }
interface Entry { id: string; no: string; kind: string; status: 'POSTED' | 'PENDING' | 'REJECTED'; amount: number; description: string; party: string | null; fund: string; createdBy: string; createdAt: string; reversed: boolean }
interface Custody { fundId: string; fund: string; userId: string; username: string; fullName: string; balance: number }
interface Trial { lines: { fund: string; account: string; debit: number; credit: number; balance: number }[]; totalDebit: number; totalCredit: number; balanced: boolean }

const KIND_AR: Record<string, string> = { RECEIPT: 'قبض', PAYMENT: 'صرف', CUSTODY_ISSUE: 'تسليم عهدة', CUSTODY_RETURN: 'إرجاع عهدة', SHORTAGE: 'عجز عهدة', OVERAGE: 'زيادة عهدة', REVERSAL: 'عكس قيد' };
const int = (v: string) => Number(v.replace(/\D/g, '')) || 0;
type Form = 'receipt' | 'payment' | 'fund' | 'custody' | null;

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return <Card className="flex flex-col gap-0.5"><span className="text-sm text-muted">{label}</span><span className="text-3xl font-bold leading-tight tabular-nums">{formatNumber(value)}</span>{note && <span className="text-sm text-muted">{note}</span>}</Card>;
}

export function Cashbox() {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canBook = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT';
  const summary = useQuery({ queryKey: ['accounting'], queryFn: () => api<Summary>('/accounting/summary') });
  const entries = useQuery({ queryKey: ['accounting', 'entries'], queryFn: () => api<Entry[]>('/accounting/entries') });
  const custody = useQuery({ queryKey: ['accounting', 'custody'], queryFn: () => api<Custody[]>('/accounting/custody') });
  const trial = useQuery({ queryKey: ['accounting', 'trial'], queryFn: () => api<Trial>('/accounting/trial-balance') });
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api<Program[]>('/programs'), enabled: canBook });
  const cashiers = useQuery({ queryKey: ['users', 'DISTRIBUTOR'], queryFn: () => api<{ id: string; fullName: string; username: string }[]>('/users/brief?role=DISTRIBUTOR'), enabled: canBook });
  const donors = useQuery({ queryKey: ['donors'], queryFn: () => api<Donor[]>('/donors'), enabled: canBook, retry: false });
  const [form, setForm] = useState<Form>(null);
  const [f, setF] = useState({ fundId: '', amount: '', party: '', description: '', category: '', name: '', programId: '', userId: '', donorId: '' });
  const [deciding, setDeciding] = useState<{ entry: Entry; approve: boolean } | null>(null);
  const [reversing, setReversing] = useState<Entry | null>(null);
  const [closing, setClosing] = useState<Custody | null>(null);
  const [counted, setCounted] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['accounting'] });
  const close = () => { setForm(null); setF({ fundId: '', amount: '', party: '', description: '', category: '', name: '', programId: '', userId: '', donorId: '' }); };

  const save = useMutation({
    mutationFn: () => {
      const base = { fundId: f.fundId, amount: int(f.amount) };
      if (form === 'receipt') return api<{ no: string }>('/accounting/receipts', { method: 'POST', body: { ...base, description: f.description.trim(), ...(f.donorId ? { donorId: f.donorId } : { party: f.party.trim() }) } });
      if (form === 'payment') return api<{ no: string }>('/accounting/payments', { method: 'POST', body: { ...base, party: f.party.trim(), description: f.description.trim(), category: f.category.trim() } });
      if (form === 'custody') return api<{ no: string }>('/accounting/custody/issue', { method: 'POST', body: { ...base, userId: f.userId } });
      return api<{ no?: string }>('/accounting/funds', { method: 'POST', body: { name: f.name.trim(), programId: f.programId || null } });
    },
    onSuccess: (r) => { toast(form === 'payment' ? `سند الصرف ${r.no} ينتظر اعتماد موظف آخر` : form === 'fund' ? 'أُنشئ الصندوق' : `سُجّل القيد ${r.no}`); close(); refresh(); },
  });
  const decide = useMutation({
    mutationFn: (note: string) => api(`/accounting/entries/${deciding!.entry.id}/${deciding!.approve ? 'approve' : 'reject'}`, { method: 'POST', body: note ? { note } : {} }),
    onSuccess: () => { toast(deciding!.approve ? 'اعتُمد القيد وثبت' : 'رُفض القيد'); setDeciding(null); refresh(); },
  });
  const reverse = useMutation({
    mutationFn: (reason: string) => api(`/accounting/entries/${reversing!.id}/reverse`, { method: 'POST', body: { reason } }),
    onSuccess: () => { toast('سُجّل قيد العكس وينتظر الاعتماد'); setReversing(null); refresh(); },
  });
  const closeCustody = useMutation({
    mutationFn: () => api<{ book: number; counted: number; difference: number }>('/accounting/custody/close', { method: 'POST', body: { fundId: closing!.fundId, userId: closing!.userId, counted: int(counted) } }),
    onSuccess: (r) => { toast(r.difference === 0 ? 'أُقفلت العهدة مطابقة' : r.difference < 0 ? `أُقفلت بعجز ${formatNumber(-r.difference)} ينتظر الاعتماد` : `أُقفلت بزيادة ${formatNumber(r.difference)} تنتظر الاعتماد`, r.difference === 0 ? 'ok' : 'info'); setClosing(null); setCounted(''); refresh(); },
  });

  if (summary.isPending) return <Skeleton className="h-48 w-full" />;
  if (summary.error) return <Alert>{summary.error.message}</Alert>;
  const s = summary.data;
  const pending = entries.data?.filter((e) => e.status === 'PENDING') ?? [];
  const fundSelect = (
    <Field label="الصندوق">{(id) => <Select id={id} value={f.fundId} onChange={(e) => setF({ ...f, fundId: e.target.value })}><option value="">اختر الصندوق</option>{s.funds.map((x) => <option key={x.id} value={x.id}>{x.name} (نقده {formatNumber(x.cash)})</option>)}</Select>}</Field>
  );
  const diff = closing ? int(counted) - closing.balance : 0;
  const formOk = form === 'fund' ? f.name.trim().length >= 2
    : !!f.fundId && int(f.amount) > 0 && (form === 'custody' ? !!f.userId : (f.party.trim().length >= 2 || (form === 'receipt' && !!f.donorId)) && f.description.trim().length >= 2 && (form !== 'payment' || f.category.trim().length >= 2));

  return (
    <>
      <PageHeader title="الصندوق والمحاسبة" description="المبالغ بالدينار العراقي. لا يُحذف قيد؛ يُعكس بقيد مقابل."
        action={canBook && (
          <div className="flex flex-wrap gap-2.5">
            <Button variant="secondary" onClick={() => setForm('fund')}>صندوق جديد</Button>
            <Button variant="secondary" onClick={() => setForm('custody')}>تسليم عهدة</Button>
            <Button variant="secondary" onClick={() => setForm('payment')}>سند صرف</Button>
            <Button onClick={() => setForm('receipt')}>سند قبض</Button>
          </div>
        )} />

      <section aria-label="مؤشرات مالية" className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-4">
        <Stat label="نقد الصناديق كلها" value={s.funds.reduce((a, x) => a + x.cash, 0)} />
        <Stat label="قُبض هذا الشهر" value={s.receivedThisMonth} />
        <Stat label="صُرف هذا الشهر" value={s.spentThisMonth} />
        <Stat label="عُهد عند الأمناء" value={s.funds.reduce((a, x) => a + x.custody, 0)} note={`${custody.data?.length ?? 0} عهدة مفتوحة`} />
      </section>

      {pending.length > 0 && (
        <Card className="flex flex-col gap-3 !border-2 !border-[#C8862A]">
          <h2 className="text-lg font-bold">قيود تنتظر الاعتماد ({pending.length})</h2>
          {pending.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center gap-3 border-b border-line pb-2.5 last:border-0">
              <div className="min-w-0 flex-1"><strong>{KIND_AR[e.kind]} {e.no}: {formatNumber(e.amount)}</strong><div className="text-sm text-muted">{e.description}{e.party ? ` · ${e.party}` : ''} · {e.fund} · سجّله {e.createdBy}</div></div>
              {e.createdBy === user?.username ? <Badge tone="warn">سجّلتَه أنت: يعتمده غيرك</Badge> : canBook && (
                <><Button variant="danger" onClick={() => setDeciding({ entry: e, approve: false })}>رفض</Button><Button onClick={() => setDeciding({ entry: e, approve: true })}>اعتماد</Button></>
              )}
            </div>
          ))}
        </Card>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[2_1_30rem] flex-col gap-5">
          <Card className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">الصناديق</h2>
            <p className="text-sm text-muted">المال المقيَّد ببرنامج يبقى في صندوقه حتى يُصرف في حملات ذلك البرنامج.</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] border-collapse text-sm">
                <thead><tr className="text-muted">{['الصندوق', 'القيد', 'النقد', 'في العهد', 'محجوز لحملات', 'المتاح'].map((h) => <th key={h} scope="col" className="border-b border-line p-2 text-start font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {s.funds.map((x) => (
                    <tr key={x.id} className="border-b border-line last:border-0">
                      <td className="p-2 font-semibold">{x.name}</td>
                      <td className="p-2">{x.program ? `لـ«${x.program}» فقط` : 'غير مقيَّد'}</td>
                      {[x.cash, x.custody, x.reserved].map((n, i) => <td key={i} className={`p-2 tabular-nums ${n < 0 ? 'font-bold text-danger' : ''}`}>{formatNumber(n)}</td>)}
                      <td className="p-2 font-bold tabular-nums">{formatNumber(x.available)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">آخر القيود</h2>
            {entries.data?.filter((e) => e.status !== 'PENDING').length === 0 && <p className="text-muted">لا قيود بعد.</p>}
            <ul className="flex flex-col">
              {entries.data?.filter((e) => e.status !== 'PENDING').slice(0, 25).map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-0">
                  <span className="min-w-14 font-semibold tabular-nums">{e.no}</span>
                  <span className="min-w-0 flex-1"><strong>{KIND_AR[e.kind]}</strong> {e.description}{e.party ? ` · ${e.party}` : ''} <span className="text-sm text-muted">· {e.fund} · {formatDateTime(e.createdAt)}</span></span>
                  <strong className="tabular-nums">{formatNumber(e.amount)}</strong>
                  {e.status === 'REJECTED' ? <Badge tone="danger">مرفوض</Badge> : e.reversed ? <Badge>معكوس</Badge>
                    : canBook && (e.kind === 'RECEIPT' || e.kind === 'PAYMENT') && <Button variant="ghost" onClick={() => setReversing(e)}>اعكسه</Button>}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-5">
          <Card className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">العُهد المفتوحة</h2>
            {custody.data?.length === 0 && <p className="text-muted">لا عهدة عند أحد.</p>}
            {custody.data?.map((x) => (
              <div key={x.fundId + x.userId} className="flex flex-wrap items-center gap-3 border-b border-line pb-2.5 last:border-0">
                <div className="min-w-0 flex-1"><strong>{x.fullName}</strong><div className="text-sm text-muted">{x.fund}</div></div>
                <strong className={`tabular-nums ${x.balance < 0 ? 'text-danger' : ''}`}>{formatNumber(x.balance)}</strong>
                {canBook && <Button variant="secondary" onClick={() => { setClosing(x); setCounted(''); }}>أقفلها</Button>}
              </div>
            ))}
          </Card>
          <Card className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold">ميزان المراجعة</h2>{trial.data && <Badge tone={trial.data.balanced ? 'ok' : 'danger'}>{trial.data.balanced ? 'متوازن' : 'غير متوازن'}</Badge>}</div>
            {trial.data && (
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 gap-y-1.5 text-sm">
                <span className="text-muted">الحساب</span><span className="text-muted">مدين</span><span className="text-muted">دائن</span>
                {trial.data.lines.map((l) => (
                  <div key={l.fund + l.account} className="contents"><span>{l.account} <span className="text-muted">· {l.fund}</span></span><span className="tabular-nums">{formatNumber(l.debit)}</span><span className="tabular-nums">{formatNumber(l.credit)}</span></div>
                ))}
                <strong className="border-t border-line pt-1.5">المجموع</strong><strong className="border-t border-line pt-1.5 tabular-nums">{formatNumber(trial.data.totalDebit)}</strong><strong className="border-t border-line pt-1.5 tabular-nums">{formatNumber(trial.data.totalCredit)}</strong>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Dialog open={form !== null} title={{ receipt: 'سند قبض', payment: 'سند صرف', fund: 'صندوق جديد', custody: 'تسليم عهدة' }[form ?? 'receipt']} onClose={() => { save.reset(); close(); }}>
        {save.error && <Alert>{save.error.message}</Alert>}
        {form === 'fund' ? (
          <>
            <Field label="اسم الصندوق">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label="مقيَّد ببرنامج" hint="المقيَّد لا يُصرف منه إلا في حملات برنامجه">{(id) => <Select id={id} value={f.programId} onChange={(e) => setF({ ...f, programId: e.target.value })}><option value="">غير مقيَّد</option>{programs.data?.filter((p) => p.kind === 'MONEY').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
          </>
        ) : (
          <>
            {fundSelect}
            <Field label="المبلغ بالدينار">{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
            {form === 'custody' ? (
              <Field label="أمين الصندوق">{(id) => <Select id={id} value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">اختر موظف التوزيع</option>{cashiers.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}</Field>
            ) : (
              <>
                {form === 'receipt' && donors.data && donors.data.length > 0 && (
                  <Field label="المتبرع" hint="اختره ليدخل التبرع في تقريره">{(id) => <Select id={id} value={f.donorId} onChange={(e) => setF({ ...f, donorId: e.target.value })}><option value="">ليس من متبرع مسجَّل</option>{donors.data.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
                )}
                {!(form === 'receipt' && f.donorId) && <Field label={form === 'receipt' ? 'من' : 'إلى'}>{(id) => <Input id={id} value={f.party} onChange={(e) => setF({ ...f, party: e.target.value })} />}</Field>}
                <Field label="البيان">{(id) => <Input id={id} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
                {form === 'payment' && <Field label="باب الصرف" hint="مشتريات، مصاريف إدارية، نقل…">{(id) => <Input id={id} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />}</Field>}
              </>
            )}
            {form === 'payment' && <p className="text-sm text-muted">سند الصرف لا يثبت ولا ينقص النقد حتى يعتمده موظف آخر.</p>}
          </>
        )}
        <div className="flex flex-wrap justify-end gap-3"><Button variant="secondary" onClick={close}>إلغاء</Button><Button disabled={!formOk || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'جارٍ الحفظ…' : 'سجّل'}</Button></div>
      </Dialog>

      <Dialog open={closing !== null} title="إقفال العهدة" onClose={() => { closeCustody.reset(); setClosing(null); }}>
        {closing && (
          <>
            <p>عهدة <strong>{closing.fullName}</strong> من «{closing.fund}». الرصيد الدفتري: <strong className="tabular-nums">{formatNumber(closing.balance)}</strong>.</p>
            <Field label="النقد الفعلي بعد العدّ">{(id) => <Input id={id} dir="ltr" inputMode="numeric" className={counted && diff !== 0 ? 'border-2 !border-danger' : ''} value={counted} onChange={(e) => setCounted(e.target.value)} />}</Field>
            {counted && diff < 0 && <Alert><strong>عجز {formatNumber(-diff)} دينار.</strong> أعد العدّ. إن ثبت أُقفلت به وفُتح قيد عجز يعتمده موظف آخر.</Alert>}
            {counted && diff > 0 && <Alert tone="warn"><strong>زيادة {formatNumber(diff)} دينار.</strong> تُسجَّل قيداً ينتظر الاعتماد.</Alert>}
            {counted && diff === 0 && <Alert tone="ok">العدّ يطابق الدفتر.</Alert>}
            {closeCustody.error && <Alert>{closeCustody.error.message}</Alert>}
            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="secondary" onClick={() => setClosing(null)}>إلغاء</Button>
              <Button variant={diff < 0 && counted ? 'danger' : 'primary'} disabled={!counted || closeCustody.isPending} onClick={() => closeCustody.mutate()}>{diff < 0 && counted ? 'أقفل بالعجز' : 'أقفل العهدة'}</Button>
            </div>
          </>
        )}
      </Dialog>
      <ReasonDialog open={deciding !== null} danger={deciding?.approve === false} required={deciding?.approve === false}
        title={deciding?.approve ? 'اعتماد القيد' : 'رفض القيد'} confirmLabel={deciding?.approve ? 'اعتماد القيد' : 'رفض القيد'}
        pending={decide.isPending} error={decide.error?.message} onClose={() => { decide.reset(); setDeciding(null); }} onConfirm={(note) => decide.mutate(note)}>
        {deciding && <p>{KIND_AR[deciding.entry.kind]} {deciding.entry.no}: <strong>{formatNumber(deciding.entry.amount)} دينار</strong> من «{deciding.entry.fund}». {deciding.entry.description}.</p>}
      </ReasonDialog>
      <ReasonDialog open={reversing !== null} title={`عكس القيد ${reversing?.no ?? ''}`} confirmLabel="سجّل قيد العكس" danger
        pending={reverse.isPending} error={reverse.error?.message} onClose={() => { reverse.reset(); setReversing(null); }} onConfirm={(reason) => reverse.mutate(reason)}>
        <p>القيد لا يُحذف. يُسجَّل قيد مقابل بالمبلغ نفسه، ولا يثبت حتى يعتمده موظف آخر.</p>
      </ReasonDialog>
    </>
  );
}
