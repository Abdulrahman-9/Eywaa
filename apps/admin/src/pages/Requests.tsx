import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';

interface Match { families: { familyId: string; familyNo: string; name: string; score: number; samePhone: boolean }[]; requests: { id: string; no: number; name: string; score: number; samePhone: boolean }[] }
interface Quick {
  id: string; no: number; headName: string; phone: string | null; mahalla: string | null; landmark: string | null; membersCount: number | null; note: string | null;
  source: 'STAFF' | 'EMERGENCY'; campaignName: string | null; status: 'NEW' | 'INVITED' | 'VISIT_ASSIGNED' | 'COMPLETED' | 'DISMISSED';
  assignedTo: string | null; assignedName: string | null; invitedAt: string | null; familyId: string | null; familyNo: string | null; createdBy: string; createdAt: string; closeNote: string | null;
  matches?: Match;
}
const STATUS = { NEW: ['جديد', 'warn'], INVITED: ['دُعي للحضور', 'info'], VISIT_ASSIGNED: ['زيارة مسندة', 'info'], COMPLETED: ['استُكمل', 'ok'], DISMISSED: ['صُرف', 'neutral'] } as const;
const DECIDERS = ['ADMIN', 'BENEFICIARY_SUPERVISOR'];
const FIELD = [...DECIDERS, 'FIELD_RESEARCHER'];

/** من يشبه صاحب الطلب في النظام. الاسم وحده هو المتاح غالباً، فهذه هي الحراسة من التكرار. */
function Matches({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['quick', id], queryFn: () => api<Quick>(`/quick-requests/${id}`) });
  const m = q.data?.matches;
  if (!m || (!m.families.length && !m.requests.length)) return null;
  return (
    <Alert tone="warn">
      <strong>قد يكون مسجَّلاً من قبل.</strong> تحقّق قبل أن تستكمل:
      <ul className="mt-1 flex flex-col gap-0.5 font-normal">
        {m.families.map((f) => <li key={f.familyId}>«{f.name}» في <Link to={`/families/${f.familyId}`} className="font-bold underline">العائلة {f.familyNo}</Link>{f.samePhone ? ' · الهاتف نفسه' : ` · تشابه الاسم ${Math.round(f.score * 100)}%`}</li>)}
        {m.requests.map((r) => <li key={r.id}>«{r.name}» في الطلب {r.no}{r.samePhone ? ' · الهاتف نفسه' : ` · تشابه الاسم ${Math.round(r.score * 100)}%`}</li>)}
      </ul>
    </Alert>
  );
}

/** طلبات التسجيل السريع: اسم وما تيسّر معه، يُستكمل بدعوة صاحبه للحضور أو بزيارة باحث. */
export function Requests() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const role = user?.role ?? '';
  const [status, setStatus] = useState('OPEN');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ headName: '', phone: '', mahalla: '', membersCount: '', note: '' });
  const [assigning, setAssigning] = useState<Quick | null>(null);
  const [assignee, setAssignee] = useState('');
  const [dismissing, setDismissing] = useState<Quick | null>(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ['quick', 'list', status, debounced], queryFn: () => api<Quick[]>(`/quick-requests?status=${status}${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`) });
  const assignees = useQuery({ queryKey: ['reassessments', 'assignees'], queryFn: () => api<{ id: string; fullName: string }[]>('/reassessments/assignees'), enabled: !!assigning });
  const refresh = () => qc.invalidateQueries({ queryKey: ['quick'] });
  const create = useMutation({
    mutationFn: () => api<Quick>('/quick-requests', { method: 'POST', body: {
      headName: form.headName.trim(), phone: form.phone.trim() || undefined, mahalla: form.mahalla.trim() || undefined,
      membersCount: Number(form.membersCount) || undefined, note: form.note.trim() || undefined, clientOpId: crypto.randomUUID(),
    } }),
    onSuccess: (r) => { toast(`سُجّل الطلب ${r.no}`); setCreating(false); refresh(); },
  });
  const act = useMutation({
    mutationFn: (v: { id: string; verb: 'invite' | 'assign' | 'dismiss'; body?: unknown; done: string }) => api(`/quick-requests/${v.id}/${v.verb}`, { method: 'POST', body: v.body ?? {} }),
    onSuccess: (_d, v) => { toast(v.done); setAssigning(null); setDismissing(null); refresh(); },
    onError: (e) => toast(e.message, 'error'),
  });

  return (
    <>
      <PageHeader title="طلبات التسجيل السريع" description="يكفي الطلبَ اسمُ رب الأسرة. يُستكمل لاحقاً: بدعوة صاحبه للحضور، أو بزيارة باحث. ولا يدخل حملة حتى يُستكمل."
        action={FIELD.includes(role) && <Button onClick={() => { setForm({ headName: '', phone: '', mahalla: '', membersCount: '', note: '' }); create.reset(); setCreating(true); }}>طلب سريع جديد</Button>} />
      <Card className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-[2]"><Field label="بحث">{(id) => <Input id={id} type="search" placeholder="الاسم أو الهاتف أو رقم الطلب" value={q} onChange={(e) => setQ(e.target.value)} />}</Field></div>
        <div className="min-w-44 flex-1">
          <Field label="الحال">
            {(id) => <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}><option value="OPEN">القائمة</option><option value="NEW">جديدة</option><option value="INVITED">دُعي أصحابها</option><option value="VISIT_ASSIGNED">زيارات مسندة</option><option value="COMPLETED">استُكملت</option><option value="DISMISSED">صُرفت</option></Select>}
          </Field>
        </div>
      </Card>
      {list.error && <Alert>{list.error.message}</Alert>}
      {list.isPending && <Skeleton className="h-24 w-full" />}
      {list.data?.length === 0 && <Card className="py-10 text-center text-muted">لا طلبات في هذا العرض.</Card>}
      <div className="flex flex-col gap-3">
        {list.data?.map((r) => {
          const open = r.status === 'NEW' || r.status === 'INVITED' || r.status === 'VISIT_ASSIGNED';
          return (
            <Card key={r.id}>
              <div data-quick={r.no} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start gap-4">
                <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2"><strong className="text-lg">{r.headName}</strong><span className="tabular-nums text-muted">طلب {r.no}</span><Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge>{r.source === 'EMERGENCY' && <Badge tone="danger">صُرف له بتخويل</Badge>}</div>
                  <span className="text-sm">{[r.phone && <bdi key="p">{r.phone}</bdi>, r.mahalla, r.membersCount && `${r.membersCount} أفراد`].filter(Boolean).map((x, i) => <span key={i}>{i > 0 && ' · '}{x}</span>)}{!r.phone && !r.mahalla && !r.membersCount && <span className="text-muted">الاسم وحده</span>}</span>
                  {r.note && <span className="text-sm">{r.note}</span>}
                  <span className="text-sm text-muted">سجّله <bdi>{r.createdBy}</bdi> · <bdi>{formatDateTime(r.createdAt)}</bdi>{r.campaignName && ` · في حملة ${r.campaignName}`}{r.assignedName && ` · يزوره ${r.assignedName}`}</span>
                  {r.status === 'COMPLETED' && r.familyId && <Link to={`/families/${r.familyId}`} className="font-semibold text-brand-strong underline">العائلة {r.familyNo}</Link>}
                  {r.status === 'DISMISSED' && <span className="text-sm text-muted">سبب الصرف: {r.closeNote}</span>}
                </div>
                {open && (
                  <div className="flex flex-wrap gap-2">
                    {FIELD.includes(role) && <Button onClick={() => navigate('/families/new', { state: { quick: r } })}>استكمل التسجيل</Button>}
                    {DECIDERS.includes(role) && <Button variant="secondary" disabled={!r.phone || act.isPending} title={r.phone ? undefined : 'لا رقم هاتف في الطلب'} onClick={() => act.mutate({ id: r.id, verb: 'invite', done: `دُعي ${r.headName} للحضور` })}>ادعُه برسالة</Button>}
                    {DECIDERS.includes(role) && <Button variant="secondary" onClick={() => { setAssignee(''); setAssigning(r); }}>أسند زيارة</Button>}
                    {DECIDERS.includes(role) && <Button variant="danger" onClick={() => setDismissing(r)}>اصرف الطلب</Button>}
                  </div>
                )}
              </div>
              {open && <Matches id={r.id} />}
              </div>
            </Card>
          );
        })}
      </div>

      <Dialog open={creating} title="طلب تسجيل سريع" onClose={() => setCreating(false)}>
        <p className="text-muted">الاسم وحده لازم. اكتب ما تيسّر من الباقي؛ يُستكمل لاحقاً باستمارة كاملة.</p>
        {create.error && <Alert>{create.error.message}</Alert>}
        <Field label="اسم رب الأسرة">{(id) => <Input id={id} value={form.headName} onChange={(e) => setForm({ ...form, headName: e.target.value })} />}</Field>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
          <Field label="الهاتف (اختياري)">{(id) => <Input id={id} dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
          <Field label="المحلة (اختيارية)">{(id) => <Input id={id} value={form.mahalla} onChange={(e) => setForm({ ...form, mahalla: e.target.value })} />}</Field>
          <Field label="عدد الأفراد (اختياري)">{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={form.membersCount} onChange={(e) => setForm({ ...form, membersCount: e.target.value.replace(/\D/g, '') })} />}</Field>
        </div>
        <Field label="ملاحظة (اختيارية)">{(id) => <Input id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setCreating(false)}>إلغاء</Button>
          <Button disabled={form.headName.trim().length < 3 || create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'جارٍ الحفظ…' : 'سجّل الطلب'}</Button>
        </div>
      </Dialog>

      <Dialog open={!!assigning} title={`زيارة ${assigning?.headName ?? ''}`} onClose={() => setAssigning(null)}>
        <p className="text-muted">يزوره الباحث، ويستكمل تسجيله من هاتفه أو من اللوحة.</p>
        <Field label="الباحث">{(id) => <Select id={id} value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">اختر</option>{(assignees.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}</Field>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setAssigning(null)}>إلغاء</Button>
          <Button disabled={!assignee || act.isPending} onClick={() => assigning && act.mutate({ id: assigning.id, verb: 'assign', body: { userId: assignee }, done: 'أُسندت الزيارة' })}>أسند الزيارة</Button>
        </div>
      </Dialog>
      <ReasonDialog open={!!dismissing} title={`صرف طلب ${dismissing?.headName ?? ''}`} confirmLabel="اصرف الطلب" danger pending={act.isPending}
        onClose={() => setDismissing(null)} onConfirm={(note) => dismissing && act.mutate({ id: dismissing.id, verb: 'dismiss', body: { note }, done: 'صُرف الطلب' })}>
        <p>يُصرف الطلب إن كان صاحبه مسجَّلاً سلفاً، أو لا يُعثر عليه، أو لا يستحق. يبقى في السجل بسببه.</p>
      </ReasonDialog>
    </>
  );
}
