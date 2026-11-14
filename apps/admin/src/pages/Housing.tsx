import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime, formatNumber, digits } from '../lib/format';
import type { FamilyRow } from '../lib/types';
import type { Fund } from './Cashbox';

type Status = 'PENDING_APPROVAL' | 'ACTIVE' | 'DELIVERED' | 'CANCELLED' | 'REJECTED';
interface Row { id: string; status: Status; location: string; budget: number; paid: number; familyNo: string; headName: string; contractor: string; waiting: number }
interface Stage { id: string; seq: number; name: string; amount: number; share: number; status: 'PLANNED' | 'CLAIMED' | 'VERIFIED' | 'PAID'; claimedAt: string | null; claimNote: string | null; verifiedBy: string | null; verifyNote: string | null; approvedBy: string | null; entryNo: string | null; photos: number }
interface Detail extends Omit<Row, 'waiting'> { familyId: string; contractorPhone: string | null; fund: string; contractDate: string; durationDays: number; daysLeft: number; createdBy: string; decidedBy: string | null; decisionNote: string | null; stages: Stage[] }
interface Contractor { id: string; name: string; activeProjects: number; deliveredProjects: number }

const STATUS = { PENDING_APPROVAL: ['ينتظر الاعتماد', 'warn'], ACTIVE: ['جارٍ', 'ok'], DELIVERED: ['مُسلَّم', 'neutral'], CANCELLED: ['ملغى', 'danger'], REJECTED: ['مرفوض', 'danger'] } as const;
const STAGE = { PLANNED: ['لم تبدأ', 'neutral'], CLAIMED: ['تنتظر زيارة تحقق', 'warn'], VERIFIED: ['تنتظر اعتماد الصرف', 'info'], PAID: ['معتمدة ومصروفة', 'ok'] } as const;
const int = (v: string) => Number(digits(v)) || 0;
const DEFAULT_STAGES = [{ name: 'الأساس', amount: '' }, { name: 'الهيكل والسقف', amount: '' }, { name: 'التشطيب', amount: '' }, { name: 'التسليم', amount: '' }];

function NewProject({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const contractors = useQuery({ queryKey: ['contractors'], queryFn: () => api<Contractor[]>('/housing/contractors'), enabled: open });
  const funds = useQuery({ queryKey: ['accounting'], queryFn: () => api<{ funds: Fund[] }>('/accounting/summary'), enabled: open, retry: false });
  const [familyNo, setFamilyNo] = useState('');
  const family = useQuery({ queryKey: ['families', 'by-no', familyNo], queryFn: () => api<FamilyRow[]>(`/families?q=${familyNo}&status=APPROVED`), enabled: open && /^\d{6,}$/.test(familyNo) });
  const found = family.data?.find((x) => x.familyNo === familyNo);
  const [form, setForm] = useState({ contractorId: '', fundId: '', location: '', contractDate: new Date().toISOString().slice(0, 10), durationDays: '120', newContractor: '' });
  const [stages, setStages] = useState(DEFAULT_STAGES);
  const budget = stages.reduce((s, x) => s + int(x.amount), 0);
  const addContractor = useMutation({
    mutationFn: () => api<{ id: string }>('/housing/contractors', { method: 'POST', body: { name: form.newContractor.trim() } }),
    onSuccess: (c) => { setForm((f) => ({ ...f, contractorId: c.id, newContractor: '' })); queryClient.invalidateQueries({ queryKey: ['contractors'] }); },
  });
  const create = useMutation({
    mutationFn: () => api<{ id: string }>('/housing/projects', {
      method: 'POST',
      body: { familyId: found!.id, contractorId: form.contractorId, fundId: form.fundId, location: form.location.trim(), contractDate: form.contractDate, durationDays: int(form.durationDays), stages: stages.filter((s) => s.name.trim() && int(s.amount) > 0).map((s) => ({ name: s.name.trim(), amount: int(s.amount) })) },
    }),
    onSuccess: (p) => { toast('أُنشئ المشروع وينتظر الاعتماد'); queryClient.invalidateQueries({ queryKey: ['housing'] }); onClose(); navigate(`/housing/${p.id}`); },
  });
  return (
    <Dialog open={open} title="مشروع بناء منزل" onClose={() => { create.reset(); onClose(); }}>
      {(create.error || addContractor.error) && <Alert>{(create.error ?? addContractor.error)!.message}</Alert>}
      <Field label="رقم العائلة" hint={found ? `${found.headName}` : familyNo && family.isSuccess ? 'لا عائلة معتمدة بهذا الرقم' : 'عائلة معتمدة'}>
        {(id) => <Input id={id} dir="ltr" inputMode="numeric" value={familyNo} onChange={(e) => setFamilyNo(e.target.value.trim())} />}
      </Field>
      <Field label="موقع البناء">{(id) => <Input id={id} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />}</Field>
      <Field label="المقاول">{(id) => <Select id={id} value={form.contractorId} onChange={(e) => setForm({ ...form, contractorId: e.target.value })}><option value="">اختر المقاول</option>{contractors.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1"><Field label="مقاول جديد">{(id) => <Input id={id} value={form.newContractor} onChange={(e) => setForm({ ...form, newContractor: e.target.value })} />}</Field></div>
        <Button variant="secondary" disabled={form.newContractor.trim().length < 3 || addContractor.isPending} onClick={() => addContractor.mutate()}>أضف المقاول</Button>
      </div>
      <Field label="يُصرف من صندوق">{(id) => <Select id={id} value={form.fundId} onChange={(e) => setForm({ ...form, fundId: e.target.value })}><option value="">اختر الصندوق</option>{funds.data?.funds.filter((f) => !f.programId).map((f) => <option key={f.id} value={f.id}>{f.name} (المتاح {formatNumber(f.available)})</option>)}</Select>}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="تاريخ العقد">{(id) => <Input id={id} type="date" value={form.contractDate} onChange={(e) => setForm({ ...form, contractDate: e.target.value })} />}</Field>
        <Field label="مدته بالأيام">{(id) => <Input id={id} inputMode="numeric" value={form.durationDays} onChange={(e) => setForm({ ...form, durationDays: e.target.value })} />}</Field>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">المراحل ودفعاتها بالدينار</legend>
        {stages.map((s, i) => (
          <div key={i} className="grid grid-cols-2 gap-2">
            <Input aria-label={`اسم المرحلة ${i + 1}`} value={s.name} onChange={(e) => setStages(stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <Input aria-label={`دفعة المرحلة ${i + 1}`} dir="ltr" inputMode="numeric" value={s.amount} onChange={(e) => setStages(stages.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
          </div>
        ))}
        <p className="text-sm">الميزانية: <strong className="tabular-nums">{formatNumber(budget)}</strong> دينار. تُحجز من الصندوق عند الاعتماد.</p>
      </fieldset>
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>إلغاء</Button>
        <Button disabled={!found || !form.contractorId || !form.fundId || form.location.trim().length < 3 || budget === 0 || create.isPending} onClick={() => create.mutate()}>أنشئ المشروع</Button>
      </div>
    </Dialog>
  );
}

export function Housing() {
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['housing'], queryFn: () => api<Row[]>('/housing/projects') });
  const canManage = user?.role === 'ADMIN' || user?.role === 'PROJECT_SUPERVISOR';
  return (
    <>
      <PageHeader title="بناء المنازل" description="لكل منزل مقاول وميزانية ومراحل. لا تُصرف دفعة مرحلة إلا بعد زيارة تحقق واعتماد موظف آخر."
        action={canManage && <Button onClick={() => setCreating(true)}>مشروع جديد</Button>} />
      {list.error && <Alert>{list.error.message}</Alert>}
      {list.isPending && <Skeleton className="h-24 w-full" />}
      {list.data?.length === 0 && <Card className="py-10 text-center text-muted">لا مشاريع بناء بعد.</Card>}
      <div className="flex flex-col gap-3">
        {list.data?.map((p) => (
          <Link key={p.id} to={`/housing/${p.id}`} className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-surface p-5 hover:border-brand">
            <div className="min-w-0 flex-[1_1_18rem]">
              <div className="flex flex-wrap items-center gap-2"><strong className="text-lg">منزل العائلة {p.familyNo}</strong><Badge tone={STATUS[p.status][1]}>{STATUS[p.status][0]}</Badge>{p.waiting > 0 && <Badge tone="warn">مرحلة تنتظر</Badge>}</div>
              <span className="text-sm text-muted">{p.headName} · {p.location} · المقاول {p.contractor}</span>
            </div>
            <div className="min-w-48 flex-1">
              <div className="mb-1 flex justify-between text-sm"><span>صُرف {formatNumber(p.paid)} من {formatNumber(p.budget)}</span><span>{Math.round((p.paid / p.budget) * 100)}%</span></div>
              <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-line"><div className="h-2 bg-brand" style={{ width: `${(p.paid / p.budget) * 100}%` }} /></div>
            </div>
          </Link>
        ))}
      </div>
      <NewProject open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function HousingProject() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoStage, setPhotoStage] = useState<string | null>(null);
  const [noting, setNoting] = useState<{ stage: Stage; verb: 'claim' | 'verify' | 'send-back' } | null>(null);
  const [paying, setPaying] = useState<Stage | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const q = useQuery({ queryKey: ['housing', id], queryFn: () => api<Detail>(`/housing/projects/${id}`) });
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ['housing'] }); queryClient.invalidateQueries({ queryKey: ['accounting'] }); };
  const act = useMutation({
    mutationFn: (v: { path: string; body?: unknown; done: string }) => api(v.path, { method: 'POST', body: v.body ?? {} }),
    onSuccess: (_d, v) => { toast(v.done); setNoting(null); setPaying(null); setRejecting(false); refresh(); },
    onError: (e) => { if (!noting && !paying && !rejecting) toast(e.message, 'error'); },
  });
  const photo = useMutation({
    mutationFn: (file: File) => { const form = new FormData(); form.set('file', file); return upload(`/housing/stages/${photoStage}/photos`, form); },
    onSuccess: () => { toast('أُرفقت الصورة بالمرحلة'); refresh(); },
    onError: (e) => toast(e.message, 'error'),
  });

  if (q.isPending) return <Skeleton className="h-48 w-full" />;
  if (q.error) return <Alert>{q.error.message}</Alert>;
  const p = q.data;
  const isSupervisor = user?.role === 'ADMIN' || user?.role === 'PROJECT_SUPERVISOR';
  const canApprove = isSupervisor || user?.role === 'ACCOUNTANT';
  const firstOpen = p.stages.find((s) => s.status !== 'PAID');
  const NOTE = {
    claim: ['طلب المقاول صرف الدفعة', 'سجّل الطلب', 'ما قاله المقاول وما رفعه من صور', 'سُجّل طلب المقاول'],
    verify: ['زيارة التحقق', 'سجّل زيارة التحقق', 'ما رأيتَه في الموقع', 'سُجّلت زيارة التحقق'],
    'send-back': ['إعادة المرحلة إلى المقاول', 'أعِد إلى المقاول', 'ما الذي لم يتمّ', 'أُعيدت المرحلة إلى المقاول'],
  } as const;

  return (
    <>
      <PageHeader
        title={`منزل العائلة ${p.familyNo}`}
        description={`${p.headName} · ${p.location}`}
        action={
          <div className="flex flex-wrap items-center gap-2.5">
            <Badge tone={STATUS[p.status][1]}>{STATUS[p.status][0]}</Badge>
            <Link to={`/families/${p.familyId}`} className="inline-flex min-h-11 items-center rounded-lg border border-line-strong bg-surface px-4 font-semibold">ملف العائلة</Link>
            {p.status === 'PENDING_APPROVAL' && canApprove && p.createdBy !== user?.username && (
              <><Button variant="danger" onClick={() => setRejecting(true)}>رفض</Button><Button disabled={act.isPending} onClick={() => act.mutate({ path: `/housing/projects/${id}/approve`, done: 'اعتُمد المشروع وحُجزت ميزانيته' })}>اعتماد المشروع</Button></>
            )}
          </div>
        }
      />
      {p.status === 'PENDING_APPROVAL' && p.createdBy === user?.username && <Alert tone="warn"><strong>هذا المشروع أنشأتَه أنت.</strong> يعتمده موظف آخر، وعندها تُحجز ميزانيته من «{p.fund}».</Alert>}
      {p.status === 'REJECTED' && <Alert><strong>مشروع مرفوض.</strong> {p.decisionNote}</Alert>}

      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-3"><h2 className="text-lg font-bold">المراحل</h2><span className="text-muted">صُرف {formatNumber(p.paid)} من {formatNumber(p.budget)} دينار ({Math.round((p.paid / p.budget) * 100)}%)</span></div>
        <ol className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-3">
          {p.stages.map((s) => {
            const current = p.status === 'ACTIVE' && firstOpen?.id === s.id;
            return (
              <li key={s.id} className={`flex flex-col gap-2 rounded-lg border p-4 ${current ? 'border-2 border-[#C8862A]' : 'border-line'}`}>
                <div className="flex justify-between gap-2"><strong className="text-lg">{s.name}</strong><span className="text-muted">{s.share}%</span></div>
                <Badge tone={STAGE[s.status][1]}>{STAGE[s.status][0]}</Badge>
                <span className="tabular-nums">{formatNumber(s.amount)} دينار</span>
                {s.claimNote && <span className="text-sm text-muted">الطلب: {s.claimNote}{s.claimedAt ? ` · ${formatDateTime(s.claimedAt)}` : ''}</span>}
                {s.verifyNote && <span className="text-sm text-muted">التحقق ({s.verifiedBy}): {s.verifyNote}</span>}
                {s.status === 'PAID' && <span className="text-sm text-muted">اعتمدها {s.approvedBy} · سند {s.entryNo}</span>}
                {s.photos > 0 && <span className="text-sm text-muted">{s.photos} صور</span>}
                {current && (
                  <div className="mt-1 flex flex-wrap gap-2">
                    {isSupervisor && <Button variant="secondary" disabled={photo.isPending} onClick={() => { setPhotoStage(s.id); fileRef.current?.click(); }}>أرفق صورة</Button>}
                    {isSupervisor && s.status === 'PLANNED' && <Button onClick={() => setNoting({ stage: s, verb: 'claim' })}>طلب المقاول صرفها</Button>}
                    {isSupervisor && s.status === 'CLAIMED' && <Button onClick={() => setNoting({ stage: s, verb: 'verify' })}>سجّل زيارة التحقق</Button>}
                    {isSupervisor && (s.status === 'CLAIMED' || s.status === 'VERIFIED') && <Button variant="danger" onClick={() => setNoting({ stage: s, verb: 'send-back' })}>أعِد إلى المقاول</Button>}
                    {canApprove && s.status === 'VERIFIED' && s.verifiedBy !== user?.username && <Button onClick={() => setPaying(s)}>اعتمد واصرف الدفعة</Button>}
                  </div>
                )}
                {current && s.status === 'CLAIMED' && <p className="text-sm font-medium text-danger">لا تُصرف دفعة مرحلة لم تُسجَّل لها زيارة تحقق.</p>}
                {current && s.status === 'VERIFIED' && s.verifiedBy === user?.username && <p className="text-sm font-medium text-warn-ink">تحققتَ منها أنت: يعتمد الصرف موظف آخر.</p>}
              </li>
            );
          })}
        </ol>
      </Card>

      <Card className="flex max-w-xl flex-col gap-1.5">
        <h2 className="text-lg font-bold">المقاول والعقد</h2>
        <strong>{p.contractor}</strong>
        {p.contractorPhone && <div><span className="text-muted">الهاتف: </span><span dir="ltr">{p.contractorPhone}</span></div>}
        <div><span className="text-muted">العقد: </span>{formatDate(p.contractDate)}، مدته {p.durationDays} يوماً</div>
        {p.status === 'ACTIVE' && <div><span className="text-muted">بقي من المدة: </span><strong className={p.daysLeft < 0 ? 'text-danger' : ''}>{p.daysLeft < 0 ? `تأخّر ${-p.daysLeft} يوماً` : `${p.daysLeft} يوماً`}</strong></div>}
        <div><span className="text-muted">الصندوق: </span>{p.fund}</div>
      </Card>

      <input ref={fileRef} type="file" accept="image/*" className="sr-only" aria-label="صورة المرحلة" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) photo.mutate(f); }} />
      <ReasonDialog open={noting !== null} danger={noting?.verb === 'send-back'} title={noting ? `${NOTE[noting.verb][0]}: ${noting.stage.name}` : ''} confirmLabel={noting ? NOTE[noting.verb][1] : ''}
        pending={act.isPending} error={act.error?.message} onClose={() => { act.reset(); setNoting(null); }}
        onConfirm={(note) => noting && act.mutate({ path: `/housing/stages/${noting.stage.id}/${noting.verb}`, body: { note }, done: NOTE[noting.verb][3] })}>
        {noting && <p className="text-muted">{NOTE[noting.verb][2]}.</p>}
      </ReasonDialog>
      <Dialog open={paying !== null} title="اعتماد المرحلة وصرف دفعتها" onClose={() => { act.reset(); setPaying(null); }}>
        {paying && <p>ستُصرف <strong>{formatNumber(paying.amount)} دينار</strong> للمقاول {p.contractor} عن مرحلة «{paying.name}»، من «{p.fund}». تحقق منها {paying.verifiedBy}: {paying.verifyNote}.</p>}
        {act.error && <Alert>{act.error.message}</Alert>}
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setPaying(null)}>إلغاء</Button>
          <Button disabled={act.isPending} onClick={() => paying && act.mutate({ path: `/housing/stages/${paying.id}/approve`, done: 'اعتُمدت المرحلة وصُرفت دفعتها' })}>اعتمد واصرف</Button>
        </div>
      </Dialog>
      <ReasonDialog open={rejecting} title="رفض المشروع" confirmLabel="رفض المشروع" danger pending={act.isPending} error={act.error?.message}
        onClose={() => { act.reset(); setRejecting(false); }} onConfirm={(note) => act.mutate({ path: `/housing/projects/${id}/reject`, body: { note }, done: 'رُفض المشروع' })} />
    </>
  );
}
