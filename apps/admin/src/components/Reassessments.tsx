import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { ReasonDialog } from './ReasonDialog';
import { useToast } from './toast';
import { Alert, Badge, Button, Card, Dialog, Field, Select } from './ui';

export interface Reassessment {
  id: string; familyId: string; familyNo: string; headName: string | null; mahalla: string | null; source: 'FAMILY' | 'STAFF' | 'AGENT'; reason: string;
  status: 'OPEN' | 'VISITED' | 'CLOSED' | 'CANCELLED'; assignedTo: string | null; assignedName: string | null; openedBy: string; openedAt: string;
  visitedBy: string | null; visitedAt: string | null; findings: string | null; outcome: 'NO_CHANGE' | 'CHANGED' | null;
  closedBy: string | null; closedAt: string | null; closeNote: string | null;
}
export const RE_STATUS = { OPEN: ['تنتظر الزيارة', 'warn'], VISITED: ['زِيرت: تنتظر الاعتماد', 'info'], CLOSED: ['اعتُمدت', 'ok'], CANCELLED: ['أُلغيت', 'neutral'] } as const;
const SOURCE = { FAMILY: 'بطلب العائلة', STAFF: 'من الإدارة', AGENT: 'بطلب متعهد من الميدان' } as const;
const OUTCOME = { NO_CHANGE: 'لم يتغيّر من حالها شيء', CHANGED: 'تغيّرت حالها' } as const;
const FIELD = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'];
const DECIDERS = ['ADMIN', 'BENEFICIARY_SUPERVISOR'];
const TEXTAREA = 'w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5';

function useRefresh() {
  const qc = useQueryClient();
  return () => { for (const key of ['reassessments', 'overview', 'family']) qc.invalidateQueries({ queryKey: [key] }); };
}

/** أزرار الطلب بحسب حاله ودور الناظر. تُستعمل في ملف العائلة وفي صف القرارات. */
export function ReassessmentActions({ r }: { r: Reassessment }) {
  const { user } = useAuth();
  const toast = useToast();
  const refresh = useRefresh();
  const [dialog, setDialog] = useState<'visit' | 'close' | 'cancel' | null>(null);
  const [findings, setFindings] = useState('');
  const [outcome, setOutcome] = useState<'NO_CHANGE' | 'CHANGED'>('NO_CHANGE');
  const role = user?.role ?? '';
  const done = (text: string) => () => { toast(text); setDialog(null); refresh(); };
  const visit = useMutation({ mutationFn: () => api(`/reassessments/${r.id}/visit`, { method: 'POST', body: { findings: findings.trim(), outcome } }), onSuccess: done('سُجّلت الزيارة. يعتمدها موظف غيرك.') });
  const close = useMutation({ mutationFn: (note: string) => api(`/reassessments/${r.id}/close`, { method: 'POST', body: note ? { note } : {} }), onSuccess: done('اعتُمدت الزيارة وأُغلق الطلب') });
  const cancel = useMutation({ mutationFn: (note: string) => api(`/reassessments/${r.id}/cancel`, { method: 'POST', body: { note } }), onSuccess: done('أُلغي الطلب') });
  const mine = r.visitedBy === user?.username;
  const forOther = role === 'FIELD_RESEARCHER' && r.assignedTo !== null && r.assignedTo !== user?.username;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {r.status === 'OPEN' && FIELD.includes(role) && (forOther ? <Badge>مسندة إلى {r.assignedName}</Badge> : <Button onClick={() => { setFindings(''); setOutcome('NO_CHANGE'); visit.reset(); setDialog('visit'); }}>سجّل الزيارة</Button>)}
      {r.status === 'OPEN' && DECIDERS.includes(role) && <Button variant="danger" onClick={() => setDialog('cancel')}>ألغِ الطلب</Button>}
      {r.status === 'VISITED' && DECIDERS.includes(role) && (mine ? <Badge tone="warn">زيارتك: يعتمدها غيرك</Badge> : <Button onClick={() => setDialog('close')}>اعتمد الزيارة</Button>)}

      <Dialog open={dialog === 'visit'} title={`زيارة العائلة ${r.familyNo}`} onClose={() => setDialog(null)}>
        <p className="text-muted">اكتب ما رأيتَه بعينك اليوم. شهادتك تُحفظ باسمك، ويعتمدها موظف غيرك.</p>
        {visit.error && <Alert>{visit.error.message}</Alert>}
        <Field label="ما وجدتَه في الزيارة">
          {(id) => <textarea id={id} rows={4} value={findings} onChange={(e) => setFindings(e.target.value)} className={TEXTAREA} placeholder="مثال: المعيل توفي في أيلول، ولا دخل للعائلة الآن، والدار إيجار." />}
        </Field>
        <Field label="النتيجة">
          {(id) => <Select id={id} value={outcome} onChange={(e) => setOutcome(e.target.value as 'NO_CHANGE' | 'CHANGED')}><option value="NO_CHANGE">{OUTCOME.NO_CHANGE}</option><option value="CHANGED">{OUTCOME.CHANGED}</option></Select>}
        </Field>
        {outcome === 'CHANGED' && <Alert tone="warn">تسجيل الزيارة لا يغيّر بيانات العائلة. بعدها قدّم ما تغيّر بزرّ «طلب تعديل» في ملفها (الدخل، الأفراد، السكن)؛ ولا تُعتمد الزيارة حتى يُفصل في تلك الطلبات.</Alert>}
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setDialog(null)}>إلغاء</Button>
          <Button disabled={findings.trim().length < 10 || visit.isPending} onClick={() => visit.mutate()}>{visit.isPending ? 'جارٍ الحفظ…' : 'سجّل الزيارة'}</Button>
        </div>
      </Dialog>
      <ReasonDialog open={dialog === 'close'} title={`اعتماد زيارة العائلة ${r.familyNo}`} confirmLabel="اعتمد الزيارة" required={false} pending={close.isPending} error={close.error?.message}
        onClose={() => { close.reset(); setDialog(null); }} onConfirm={(note) => close.mutate(note)}>
        <p><strong>{r.outcome && OUTCOME[r.outcome]}.</strong> {r.findings}</p>
        <p className="text-muted">باعتمادك تُعدّ بيانات العائلة محدَّثة إلى اليوم، وتُعاد نقاطها.</p>
      </ReasonDialog>
      <ReasonDialog open={dialog === 'cancel'} title={`إلغاء طلب إعادة تقييم العائلة ${r.familyNo}`} confirmLabel="ألغِ الطلب" danger pending={cancel.isPending} error={cancel.error?.message}
        onClose={() => { cancel.reset(); setDialog(null); }} onConfirm={(note) => cancel.mutate(note)} />
    </div>
  );
}

export function ReassessmentSummary({ r }: { r: Reassessment }) {
  return (
    <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2"><Badge tone={RE_STATUS[r.status][1]}>{RE_STATUS[r.status][0]}</Badge><span className="text-sm text-muted">{SOURCE[r.source]} · فتحه <bdi>{r.openedBy}</bdi> · <bdi>{formatDateTime(r.openedAt)}</bdi></span></div>
      <span><span className="text-muted">السبب: </span>{r.reason}</span>
      {r.status === 'OPEN' && r.assignedName && <span className="text-sm text-muted">مسندة إلى {r.assignedName}</span>}
      {r.findings && <span><span className="text-muted">الزيارة (<bdi>{r.visitedBy}</bdi>، <bdi>{r.visitedAt && formatDateTime(r.visitedAt)}</bdi>): </span><strong>{r.outcome && OUTCOME[r.outcome]}.</strong> {r.findings}</span>}
      {r.closedBy && <span className="text-sm text-muted">{r.status === 'CANCELLED' ? 'ألغاه' : 'اعتمدها'} <bdi>{r.closedBy}</bdi>{r.closeNote && `: ${r.closeNote}`}</span>}
    </div>
  );
}

/** بطاقة إعادة التقييم في ملف العائلة. */
export function FamilyReassessments({ familyId, familyNo, approved }: { familyId: string; familyNo: string; approved: boolean }) {
  const { user } = useAuth();
  const toast = useToast();
  const refresh = useRefresh();
  const [opening, setOpening] = useState(false);
  const [source, setSource] = useState<'FAMILY' | 'STAFF'>('FAMILY');
  const [reason, setReason] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const role = user?.role ?? '';
  const list = useQuery({ queryKey: ['reassessments', familyId], queryFn: () => api<Reassessment[]>(`/reassessments?familyId=${familyId}`) });
  const assignees = useQuery({ queryKey: ['reassessments', 'assignees'], queryFn: () => api<{ id: string; fullName: string }[]>('/reassessments/assignees'), enabled: opening });
  useEffect(() => { if (opening) { setSource('FAMILY'); setReason(''); setAssignedTo(''); } }, [opening]);
  const open = useMutation({
    mutationFn: () => api('/reassessments', { method: 'POST', body: { familyId, source, reason: reason.trim(), ...(assignedTo ? { assignedTo } : {}) } }),
    onSuccess: () => { toast('فُتح طلب إعادة التقييم'); setOpening(false); refresh(); },
  });
  const rows = list.data ?? [];
  const hasOpen = rows.some((r) => r.status === 'OPEN' || r.status === 'VISITED');

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold">إعادة التقييم</h2>
          <p className="text-sm text-muted">تُفتح بطلب من العائلة أو من الإدارة، ثم زيارة، ثم يعتمدها غير من زار.</p>
        </div>
        {approved && !hasOpen && FIELD.includes(role) && <Button variant="secondary" onClick={() => { open.reset(); setOpening(true); }}>افتح طلب إعادة تقييم</Button>}
      </div>
      {list.error && <Alert>{list.error.message}</Alert>}
      {list.isSuccess && rows.length === 0 && <p className="text-muted">لم يُطلب لهذه العائلة إعادة تقييم.</p>}
      {rows.map((r) => (
        <div key={r.id} className="flex flex-wrap items-start gap-3 rounded-lg border border-line px-4 py-3"><ReassessmentSummary r={r} /><ReassessmentActions r={r} /></div>
      ))}

      <Dialog open={opening} title={`إعادة تقييم العائلة ${familyNo}`} onClose={() => setOpening(false)}>
        {open.error && <Alert>{open.error.message}</Alert>}
        <Field label="من طلبها؟">
          {(id) => <Select id={id} value={source} onChange={(e) => setSource(e.target.value as 'FAMILY' | 'STAFF')}><option value="FAMILY">العائلة نفسها</option><option value="STAFF">الإدارة</option></Select>}
        </Field>
        <Field label="السبب (لازم)">
          {(id) => <textarea id={id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={TEXTAREA} placeholder="مثال: توفي معيلها وانقطع دخلها" />}
        </Field>
        <Field label="من يزورها؟" hint="إن تُركت لأي باحث ظهرت للباحثين كلهم.">
          {(id) => <Select id={id} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}><option value="">أي باحث</option>{(assignees.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
        </Field>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setOpening(false)}>إلغاء</Button>
          <Button disabled={reason.trim().length < 3 || open.isPending} onClick={() => open.mutate()}>{open.isPending ? 'جارٍ الفتح…' : 'افتح الطلب'}</Button>
        </div>
      </Dialog>
    </Card>
  );
}

/** ما على هذا الموظف زيارته. يظهر أعلى قائمة العوائل. */
export function VisitsTodo() {
  const todo = useQuery({ queryKey: ['reassessments', 'mine'], queryFn: () => api<Reassessment[]>('/reassessments?mine=true') });
  if (!todo.data?.length) return null;
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-lg font-bold">زيارات إعادة تقييم مطلوبة ({todo.data.length})</h2>
      <ul className="flex flex-col">
        {todo.data.slice(0, 8).map((r) => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-2 last:border-0">
            <Link to={`/families/${r.familyId}`} className="font-semibold text-brand-strong underline">{r.headName ?? r.familyNo}</Link>
            <span className="text-sm tabular-nums text-muted">{r.familyNo}{r.mahalla && ` · ${r.mahalla}`}</span>
            <span className="min-w-0 flex-1 text-sm">{r.reason}</span>
          </li>
        ))}
      </ul>
      {todo.data.length > 8 && <p className="text-sm text-muted">و{todo.data.length - 8} غيرها.</p>}
    </Card>
  );
}
