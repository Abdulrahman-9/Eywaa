import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardCheck, Minus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { formatAgo, formatDateTime, formatNumber } from '../lib/format';
import { FAMILY_STATUS, type FamilyStatus } from '../lib/labels';
import { CLASS_AR } from '../pages/Scoring';
import { ReasonDialog } from './ReasonDialog';
import { useToast } from './toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Segmented, Select, Skeleton } from './ui';

type Rec = 'CONFIRM' | 'RAISE' | 'LOWER' | 'REMOVE' | 'UNABLE';
type Effect = 'NONE' | 'RAISED' | 'LOWERED' | 'REMOVED';
interface CheckLine { key: string; label: string; recorded: string; result: 'MATCH' | 'MISMATCH' | 'UNCHECKED'; found?: string }
export interface InspectionReport {
  id: string; inspectorId: string; inspector: string; role: string; submittedAt: string | null; visitedAt: string | null; contact: 'FAMILY' | 'OTHERS' | 'NONE' | null;
  notes: string | null; recommendation: Rec | null; reason: string | null; checks: CheckLine[]; mismatches: number;
}
export interface Inspection {
  id: string; no: number; status: 'ASSIGNED' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; familyId: string; familyNo: string; headName: string | null; mahalla: string | null; familyStatus: FamilyStatus;
  note: string | null; requestedBy: string; requestedAt: string; reports: InspectionReport[]; submitted: number; assigned: number; waiting: boolean; late: boolean; agreement: 'AGREE' | 'DISAGREE' | null;
  decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; effect: Effect | null; points: number | null; deltaBefore: number | null; deltaAfter: number | null;
  pointsBefore: number | null; pointsAfter: number | null; classBefore: string | null; classAfter: string | null; familyApproved: boolean;
}
interface Detail extends Inspection {
  family: {
    familyNo: string; status: FamilyStatus; headName: string | null; phone: string | null; address: string; delta: number; inspectedAt: string | null;
    members: { name: string; relation: string; age: number | null; isOrphan: boolean; disability: string | null; chronicIllness: string | null }[];
    facts: { key: string; label: string; recorded: string }[]; score: { points: number; class: string; base: number } | null;
  };
  cap: number; thresholds: { a: number; b: number; c: number }; maxPoints: number;
}
interface Candidate { id: string; familyNo: string; headName: string | null; mahalla: string | null; status: FamilyStatus; members: number; class: string | null; points: number | null; inspectedAt: string | null; inspecting: boolean }
interface Inspector { id: string; fullName: string; role: string; open: number; done30: number }

export const INSPECTION_DECIDERS = ['ADMIN', 'BENEFICIARY_SUPERVISOR'];
export const INSPECTION_READERS = [...INSPECTION_DECIDERS, 'DISTRIBUTION_MANAGER', 'AUDITOR'];
const REC: Record<Rec, [string, 'ok' | 'info' | 'warn' | 'danger' | 'neutral']> = {
  CONFIRM: ['مطابقة: لا تغيير', 'ok'], RAISE: ['يوصي برفع النقاط', 'info'], LOWER: ['يوصي بخفض النقاط', 'warn'], REMOVE: ['يطلب شطب العائلة', 'danger'], UNABLE: ['تعذّر الكشف', 'neutral'],
};
const CONTACT = { FAMILY: 'قابل العائلة في دارها', OTHERS: 'لم يجدها وسأل من يعرفها', NONE: 'لم يجد العائلة ولا من يعرفها' } as const;
const STATUS: Record<Inspection['status'], [string, 'ok' | 'info' | 'warn' | 'danger' | 'neutral']> = {
  ASSIGNED: ['قيد الكشف', 'info'], SUBMITTED: ['ينتظر الاعتماد', 'warn'], APPROVED: ['معتمد', 'ok'], REJECTED: ['لم يُعتمد', 'danger'], CANCELLED: ['أُلغي', 'neutral'],
};
const ROLE = { DISTRIBUTION_AGENT: 'متعهد', FIELD_RESEARCHER: 'باحث' } as Record<string, string>;
/** تعديل الكشف بالكلمات: الإشارة قبل الرقم تلتبس في نص يُقرأ من اليمين. */
export const deltaText = (n: number) => (n > 0 ? `رفع ${n}` : n < 0 ? `خفض ${-n}` : 'لا تعديل');
const membersText = (n: number) => (n === 1 ? 'فرد واحد' : n === 2 ? 'فردان' : n <= 10 ? `${n} أفراد` : `${n} فرداً`);
const classOf = (p: number, t: { a: number; b: number; c: number }) => (p >= t.a ? 'A' : p >= t.b ? 'B' : p >= t.c ? 'C' : 'D');

/** أثر الكشف المعتمد بعبارة واحدة: ماذا غيّر في العائلة. */
export function effectText(i: Pick<Inspection, 'effect' | 'points' | 'pointsBefore' | 'pointsAfter' | 'classBefore' | 'classAfter'>): string {
  if (i.effect === 'NONE') return 'بلا أثر: حالها كما سُجّل';
  if (i.effect === 'REMOVED') return 'شُطبت العائلة';
  if (i.effect !== 'RAISED' && i.effect !== 'LOWERED') return '';
  const verb = i.effect === 'RAISED' ? 'رفع النقاط' : 'خفض النقاط';
  if (i.pointsAfter === null) return `${verb} ${i.points}، تسري عند اعتماد العائلة`;
  // اعتُمدت العائلة مع كشفها: لا نقاط لها قبله.
  if (i.pointsBefore === null) return `${verb} ${i.points}: صارت نقاطها ${i.pointsAfter} عند اعتمادها`;
  const moved = i.classBefore !== i.classAfter ? `، وانتقلت من الفئة ${CLASS_AR[i.classBefore ?? '']} إلى ${CLASS_AR[i.classAfter ?? '']}` : '';
  return `${verb} ${i.points}: من ${i.pointsBefore} إلى ${i.pointsAfter}${moved}`;
}
const EFFECT_TONE: Record<Effect, 'ok' | 'info' | 'warn' | 'danger'> = { NONE: 'ok', RAISED: 'info', LOWERED: 'warn', REMOVED: 'danger' };

function refreshAll(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of ['inspections', 'family', 'families', 'overview', 'agents', 'agent']) queryClient.invalidateQueries({ queryKey: [key] });
}

/** سطر الكشف في القوائم: العائلة، من كشف وبمَ أوصى، وما آل إليه. */
export function InspectionRow({ i, onOpen, withFamily = true }: { i: Inspection; onOpen: () => void; withFamily?: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-3 last:border-0" data-testid="inspection">
      <div className="min-w-0 flex-[1_1_18rem]">
        <div className="flex flex-wrap items-center gap-2">
          <strong>كشف <bdi>{i.no}</bdi></strong>
          {withFamily && <><span className="text-muted">على</span><Link to={`/families/${i.familyId}`} className="font-semibold text-brand-strong hover:underline">العائلة <bdi>{i.familyNo}</bdi> · {i.headName ?? '—'}</Link></>}
          {i.status === 'ASSIGNED' && i.submitted > 0 ? <Badge tone="warn">رُفع {i.submitted} من {i.assigned}</Badge> : <Badge tone={STATUS[i.status][1]}>{STATUS[i.status][0]}</Badge>}
          {i.late && <Badge tone="danger">متأخر</Badge>}
          {i.agreement === 'DISAGREE' && <Badge tone="warn">اختلف الكاشفان</Badge>}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-sm">
          {i.reports.map((r) => (
            <span key={r.id} className="inline-flex flex-wrap items-center gap-1.5">
              <span className="text-muted">{r.inspector}:</span>
              {r.recommendation ? <Badge tone={REC[r.recommendation][1]}>{REC[r.recommendation][0]}</Badge> : <span className="text-muted">لم يرفع بعد</span>}
              {r.mismatches > 0 && <span className="font-semibold text-danger">{r.mismatches} غير مطابق</span>}
            </span>
          ))}
        </div>
        <div className="pt-1 text-sm text-muted">
          {i.status === 'APPROVED' && i.effect ? <span className={cn('font-semibold', i.effect === 'NONE' ? 'text-brand-strong' : 'text-ink')}>{effectText(i)}{i.familyApproved ? '، واعتُمد تسجيلها' : ''}</span>
            : i.status === 'REJECTED' || i.status === 'CANCELLED' ? i.decisionNote
            : <>كلّف به {i.requestedBy} {formatAgo(i.requestedAt)}{withFamily && i.mahalla ? ` · ${i.mahalla}` : ''}</>}
          {i.decidedAt && <> · {i.decidedBy} · <bdi>{formatDateTime(i.decidedAt)}</bdi></>}
        </div>
      </div>
      <Button variant={i.waiting ? 'primary' : 'secondary'} onClick={onOpen}>{i.waiting ? 'افصل فيه' : 'افتحه'}</Button>
    </li>
  );
}

type Choice = 'NONE' | 'RAISE' | 'LOWER' | 'REMOVE' | 'REJECT';
const CHOICES: [Choice, string, string][] = [
  ['NONE', 'اعتماد بلا أثر', 'حالها كما سُجّل. تصير العائلة مكشوفة.'],
  ['RAISE', 'رفع النقاط', 'حالها أشدّ مما تحمله حقول السجل.'],
  ['LOWER', 'خفض النقاط', 'حالها أيسر مما تحمله حقول السجل.'],
  ['REMOVE', 'شطب العائلة', 'تخرج من المستفيدين ويبقى سجلها.'],
  ['REJECT', 'لا يُعتمد الكشف', 'لا يُبنى عليه شيء، وتبقى العائلة كما كانت.'],
];
const EFFECT_OF: Record<string, Choice> = { CONFIRM: 'NONE', RAISE: 'RAISE', LOWER: 'LOWER', REMOVE: 'REMOVE' };

/** الكشف بتفصيله: ما في السجل مقابل ما وجده كل كاشف، ثم قرار المدير بمعاينة أثره قبل اتخاذه. */
export function InspectionDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['inspections', id], queryFn: () => api<Detail>(`/inspections/${id}`), enabled: !!id });
  const [choice, setChoice] = useState<Choice | null>(null);
  const [points, setPoints] = useState('');
  const [note, setNote] = useState('');
  const [approveFamily, setApproveFamily] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const d = q.data;
  const done = d?.reports.filter((r) => r.submittedAt) ?? [];
  const real = done.filter((r) => r.recommendation !== 'UNABLE');
  useEffect(() => {
    if (!d) return;
    // إن اتفق من كشف على توصية فهي المختارة ابتداءً؛ وإن اختلفوا فالمدير يختار.
    const recs = new Set(d.reports.filter((r) => r.submittedAt && r.recommendation !== 'UNABLE').map((r) => r.recommendation));
    setChoice(recs.size === 1 ? EFFECT_OF[[...recs][0]!] : null);
    setPoints(''); setNote(''); setApproveFamily(false);
  }, [d?.id, d?.submitted]); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = useMutation({
    mutationFn: () => api<Inspection>(`/inspections/${id}/decide`, {
      method: 'POST',
      body: choice === 'REJECT' ? { decision: 'REJECT', note: note.trim() } : { decision: 'APPROVE', effect: choice, ...(choice === 'RAISE' || choice === 'LOWER' ? { points: Number(points) } : {}), ...(approveFamily && choice !== 'REMOVE' ? { approveFamily: true } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
    }),
    onSuccess: (r) => { toast(r.status === 'REJECTED' ? 'رُدّ الكشف ولم يُعتمد' : `اعتُمد الكشف. ${effectText(r)}${r.familyApproved ? '، واعتُمد تسجيل العائلة' : ''}`, r.effect === 'REMOVED' ? 'info' : 'ok'); refreshAll(queryClient); onClose(); },
  });
  const cancel = useMutation({
    mutationFn: (why: string) => api(`/inspections/${id}/cancel`, { method: 'POST', body: { note: why } }),
    onSuccess: () => { toast('أُلغي التكليف'); setCancelling(false); refreshAll(queryClient); onClose(); },
  });

  const open = d?.status === 'ASSIGNED' || d?.status === 'SUBMITTED';
  const canDecide = !!user && INSPECTION_DECIDERS.includes(user.role) && open;
  const p = Number(points) || 0;
  const preview = useMemo(() => {
    if (!d || (choice !== 'RAISE' && choice !== 'LOWER') || !p) return null;
    const after = Math.max(-d.cap, Math.min(d.cap, d.family.delta + (choice === 'RAISE' ? p : -p)));
    if (after === d.family.delta) return { blocked: true as const, after };
    if (!d.family.score) return { blocked: false as const, after, pending: true as const };
    const pts = Math.min(Math.max(d.family.score.base + after, 0), d.maxPoints);
    return { blocked: false as const, after, pending: false as const, points: pts, cls: classOf(pts, d.thresholds) };
  }, [d, choice, p]);
  const backed = !!choice && choice !== 'REJECT' && real.some((r) => EFFECT_OF[r.recommendation ?? ''] === choice);
  const needNote = choice === 'REJECT' || (!!choice && !backed);
  const mismatches = done.reduce((n, r) => n + r.mismatches, 0);
  const unableOnly = done.length > 0 && real.length === 0;
  const ready = !!choice && (!needNote || note.trim().length >= 3) && (choice !== 'RAISE' && choice !== 'LOWER' || (p >= 1 && p <= (d?.cap ?? 0) && !preview?.blocked)) && !(unableOnly && choice !== 'REMOVE' && choice !== 'REJECT');
  const verb = choice === 'NONE' ? 'اعتمد بلا أثر' : choice === 'RAISE' ? `ارفع ${p || ''} نقاط` : choice === 'LOWER' ? `اخفض ${p || ''} نقاط` : choice === 'REMOVE' ? 'اشطب العائلة' : choice === 'REJECT' ? 'ردّ الكشف' : 'اختر الأثر';
  const cell = (c?: CheckLine) => !c || c.result === 'UNCHECKED' ? <span className="inline-flex items-center gap-1 text-muted"><Minus aria-hidden="true" className="size-4" />لم يتحقق</span>
    : c.result === 'MATCH' ? <span className="inline-flex items-center gap-1 font-semibold text-brand-strong"><Check aria-hidden="true" className="size-4" />مطابق</span>
    : <span className="inline-flex items-start gap-1 font-semibold text-danger"><X aria-hidden="true" className="mt-0.5 size-4 flex-none" /><span>غير مطابق: <span className="font-normal text-ink">{c.found}</span></span></span>;

  return (
    <>
      <Dialog open={!!id} title={d ? `كشف ${d.no} على العائلة ${d.familyNo}` : 'كشف ميداني'} onClose={onClose} wide>
        {q.isPending && <Skeleton className="h-64 w-full" />}
        {q.error && <Alert>{q.error.message}</Alert>}
        {d && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/families/${d.familyId}`} onClick={onClose} className="text-lg font-bold text-brand-strong hover:underline">{d.family.headName ?? '—'}</Link>
              <Badge tone={FAMILY_STATUS[d.family.status].tone}>{FAMILY_STATUS[d.family.status].label}</Badge>
              {d.family.score && <span className="rounded-md bg-brand-strong px-2.5 py-0.5 text-sm font-bold text-white">الفئة {CLASS_AR[d.family.score.class]} · {d.family.score.points} نقطة</span>}
              {d.family.delta !== 0 && <Badge tone="info">عليها تعديل كشف سابق: {deltaText(d.family.delta)}</Badge>}
              <Badge tone={STATUS[d.status][1]}>{STATUS[d.status][0]}</Badge>
            </div>
            <p className="text-sm text-muted">{d.family.address || 'بلا عنوان'} · {membersText(d.family.members.length)} · كلّف به {d.requestedBy} <bdi>{formatDateTime(d.requestedAt)}</bdi></p>
            {d.note && <p className="rounded-lg bg-info-soft px-3 py-2 text-info-ink"><strong>طُلب التحقق من:</strong> {d.note}</p>}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] border-collapse text-sm" data-testid="checks">
                <thead><tr className="text-muted"><th scope="col" className="border-b border-line p-2 text-start font-medium">البند</th><th scope="col" className="border-b border-line p-2 text-start font-medium">في السجل</th>
                  {d.reports.map((r) => <th key={r.id} scope="col" className="border-b border-line p-2 text-start font-medium">{r.inspector}</th>)}</tr></thead>
                <tbody>
                  {d.family.facts.map((f) => {
                    const cells = d.reports.map((r) => r.checks.find((c) => c.key === f.key));
                    const recorded = cells.find((c) => c)?.recorded ?? f.recorded;
                    return (
                      <tr key={f.key} className={cn('border-b border-line align-top last:border-0', cells.some((c) => c?.result === 'MISMATCH') && 'bg-danger-soft/40')}>
                        <th scope="row" className="p-2 text-start font-semibold">{f.label}</th><td className="p-2">{recorded}</td>
                        {d.reports.map((r, n) => <td key={r.id} className="p-2">{r.submittedAt ? cell(cells[n]) : <span className="text-muted">—</span>}</td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(16rem,1fr))]">
              {d.reports.map((r) => (
                <div key={r.id} className="flex flex-col gap-1.5 rounded-xl border border-line p-3.5" data-testid="report">
                  <div className="flex flex-wrap items-center gap-2"><strong>{r.inspector}</strong><span className="text-sm text-muted">{ROLE[r.role] ?? r.role}</span>{r.recommendation && <Badge tone={REC[r.recommendation][1]}>{REC[r.recommendation][0]}</Badge>}</div>
                  {!r.submittedAt ? <p className="text-muted">لم يرفع تقريره بعد.</p> : (
                    <>
                      <p className="text-sm text-muted">{r.contact ? CONTACT[r.contact] : ''} · زار <bdi>{formatDateTime(r.visitedAt!)}</bdi></p>
                      {r.reason && <p><span className="text-muted">سببه: </span>{r.reason}</p>}
                      {r.notes && <p><span className="text-muted">ملاحظاته: </span>{r.notes}</p>}
                    </>
                  )}
                </div>
              ))}
            </div>

            {!open && (
              <div className={cn('rounded-xl px-4 py-3', d.status === 'APPROVED' ? 'bg-brand-soft' : 'bg-ground')}>
                <strong>{d.status === 'APPROVED' ? `${effectText(d)}${d.familyApproved ? '، واعتُمد تسجيلها' : ''}` : STATUS[d.status][0]}</strong>
                {d.status === 'APPROVED' && d.deltaBefore !== d.deltaAfter && d.effect !== 'REMOVED' && <span className="text-sm text-muted"> · تعديل الكشف عليها صار «{deltaText(d.deltaAfter ?? 0)}» بعد «{deltaText(d.deltaBefore ?? 0)}»</span>}
                {d.decisionNote && <p>{d.decisionNote}</p>}
                {d.decidedBy && <p className="text-sm text-muted">{d.decidedBy} · <bdi>{formatDateTime(d.decidedAt!)}</bdi></p>}
              </div>
            )}

            {canDecide && done.length === 0 && <p className="text-muted">لا يُفصل فيه قبل أن يُرفع تقرير. إن لم يعد لازماً أو أردتَ تبديل الكاشف فألغِ التكليف.</p>}
            {canDecide && done.length > 0 && (
              <div className="flex flex-col gap-3 border-t border-line pt-4">
                <h3 className="text-lg font-bold">قرارك</h3>
                {d.assigned > done.length && <Alert tone="warn">رُفع {done.length} من {d.assigned}. إن فصلتَ الآن فبما وصل، ويسقط ما لم يُرفع.</Alert>}
                {unableOnly && <Alert tone="warn">تعذّر الكشف على من كُلّف به، فلا يُعتمد كأنه وقع. ردّه وأعد التكليف، أو اشطب العائلة بسبب.</Alert>}
                {mismatches > 0 && <Alert tone="warn"><strong>في الكشف {mismatches === 1 ? 'بند غير مطابق' : `${mismatches} بنود غير مطابقة`}.</strong> ما كان منها بياناً خاطئاً في السجل (سكن، دخل، عدد أفراد، هاتف) فصحّحه بطلب تعديل من ملف العائلة: المعادلة تحسب أثره. ورفع النقاط وخفضها هنا لما لا تحمله الحقول.</Alert>}
                <div role="radiogroup" aria-label="أثر الكشف" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {CHOICES.map(([key, title, hint]) => (
                    <button key={key} type="button" role="radio" aria-checked={choice === key} onClick={() => { decide.reset(); setChoice(key); }}
                      className={cn('flex flex-col rounded-xl border px-3.5 py-2.5 text-start transition-colors', choice === key ? 'border-brand bg-brand-soft ring-2 ring-brand/25' : 'border-line-strong hover:border-brand', key === 'REMOVE' && choice === key && '!border-danger !bg-danger-soft !ring-danger/20')}>
                      <span className="font-bold">{title}{real.some((r) => EFFECT_OF[r.recommendation ?? ''] === key) && <span className="ms-2 text-sm font-medium text-brand-strong">توصية الكاشف</span>}</span>
                      <span className="text-sm text-muted">{hint}</span>
                    </button>
                  ))}
                </div>
                {(choice === 'RAISE' || choice === 'LOWER') && (
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="w-40"><Field label="عدد النقاط" hint={`من 1 إلى ${d.cap}`}>{(fid) => <Input id={fid} dir="ltr" inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value.replace(/\D/g, ''))} />}</Field></div>
                    <p className="min-w-0 flex-1 pb-1" data-testid="preview" aria-live="polite">
                      {!p ? <span className="text-muted">اكتب العدد لترى ما تصير إليه نقاطها وفئتها.</span>
                        : p > d.cap ? <span className="font-semibold text-danger">أقصى ما يغيّره الكشف {d.cap} نقاط.</span>
                        : preview?.blocked ? <span className="font-semibold text-danger">بلغ تعديل الكشف على هذه العائلة حدّه ({deltaText(d.family.delta)}).</span>
                        : preview?.pending ? <>يصير تعديل الكشف عليها <strong>«{deltaText(preview.after)}»</strong>، {approveFamily ? 'وتُحسب نقاطها به عند اعتمادها الآن' : 'ويسري عند اعتمادها'}.</>
                        : preview && d.family.score ? <>تصير نقاطها <strong className="text-xl tabular-nums">{preview.points}</strong> بعد <strong className="tabular-nums">{d.family.score.points}</strong>
                          {preview.cls !== d.family.score.class ? <strong className="text-warn-ink">، وتنتقل من الفئة {CLASS_AR[d.family.score.class]} إلى {CLASS_AR[preview.cls]}</strong> : <>، وتبقى في الفئة {CLASS_AR[preview.cls]}</>}.
                          {Math.abs(preview.after - d.family.delta) < p && <span className="text-sm text-muted"> (يُحتسب منها {Math.abs(preview.after - d.family.delta)} فقط: الحدّ {d.cap})</span>}</> : null}
                    </p>
                  </div>
                )}
                {choice === 'REMOVE' && <Alert><strong>تُشطب العائلة من المستفيدين.</strong> يبقى سجلها ووثائقها محجوزة فلا تُسجَّل ثانية دون أن يظهر شطبها، ويسقط ما بقي لها من استحقاق لم يُسلَّم. {d.family.status !== 'APPROVED' && 'وهي لم تُعتمد بعد، فيُرفض سجلها.'}</Alert>}
                {choice && choice !== 'REMOVE' && choice !== 'REJECT' && d.family.status === 'PENDING_APPROVAL' && (
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line-strong px-3.5 py-2.5">
                    <input type="checkbox" className="mt-1 size-5 flex-none accent-[#0f6b5c]" checked={approveFamily} onChange={(e) => setApproveFamily(e.target.checked)} />
                    <span><strong>واعتمد تسجيل العائلة الآن</strong><span className="block text-sm text-muted">هي تنتظر الاعتماد. تدخل المستفيدين وتُحسب نقاطها، وشهادتك على صحة سجلها تُحفظ باسمك.</span></span>
                  </label>
                )}
                {choice && choice !== 'REMOVE' && choice !== 'REJECT' && d.family.status === 'PENDING_DEDUPE_REVIEW' && <p className="text-sm text-muted">في سجلها شبهة تكرار لم يُفصل فيها، فلا تُعتمد مع الكشف. افصل في الشبهة من «الاعتماد والشبهات».</p>}
                {choice && (
                  <Field label={needNote ? (choice === 'REJECT' ? 'لماذا لا يُعتمد (لازم)' : 'قرارك يخالف توصية الكاشف: سببه (لازم)') : 'ملاحظة (اختيارية)'}>
                    {(fid) => <textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5" />}
                  </Field>
                )}
                {decide.error && <Alert>{decide.error.message}</Alert>}
              </div>
            )}
            {canDecide && (
              <div className="flex flex-wrap justify-end gap-3">
                <Button variant="ghost" onClick={() => { cancel.reset(); setCancelling(true); }}>ألغِ التكليف</Button>
                {done.length > 0 && <Button variant={choice === 'REMOVE' || choice === 'REJECT' ? 'danger' : 'primary'} loading={decide.isPending} disabled={!ready} onClick={() => decide.mutate()}>{verb}</Button>}
              </div>
            )}
          </>
        )}
      </Dialog>
      <ReasonDialog open={cancelling} title="إلغاء التكليف بالكشف" confirmLabel="ألغِ التكليف" danger pending={cancel.isPending} error={cancel.error?.message}
        onClose={() => setCancelling(false)} onConfirm={(why) => cancel.mutate(why)}>
        <p>يُلغى لتبديل الكاشف أو لأن الكشف لم يعد لازماً. ما رُفع من تقاريره يبقى في السجل ولا يُبنى عليه شيء.</p>
      </ReasonDialog>
    </>
  );
}

/** التكليف بالكشف: تُختار العوائل (بالتصفية أو بأرقامها)، ثم الكاشف أو الكاشفان. */
export function AssignDialog({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: { id: string; familyNo: string; headName: string | null } }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const inspectors = useQuery({ queryKey: ['inspections', 'inspectors'], queryFn: () => api<Inspector[]>('/inspections/inspectors'), enabled: open });
  const [how, setHow] = useState<'filter' | 'numbers'>('filter');
  const [f, setF] = useState({ status: 'ANY', state: 'NONE', mahalla: '', cls: '', limit: '50', numbers: '' });
  const [found, setFound] = useState<{ families: Candidate[]; unknown: string[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [a, setA] = useState({ first: '', second: '', mode: 'BOTH' as 'BOTH' | 'SPLIT', note: '' });
  const [skipped, setSkipped] = useState<{ familyNo: string; reason: string }[] | null>(null);
  useEffect(() => { if (open) { setFound(null); setPicked(new Set()); setA({ first: '', second: '', mode: 'BOTH', note: '' }); setSkipped(null); } }, [open]);

  const search = useMutation({
    mutationFn: () => api<{ families: Candidate[]; unknown: string[] }>('/inspections/candidates', {
      method: 'POST',
      body: how === 'numbers' ? { familyNos: f.numbers.split(/[\s,،]+/).map((x) => x.trim()).filter(Boolean) }
        : { status: f.status, state: f.state, ...(f.mahalla.trim() ? { mahalla: f.mahalla.trim() } : {}), ...(f.cls ? { class: f.cls } : {}), limit: Math.min(500, Math.max(1, Number(f.limit) || 50)) },
    }),
    onSuccess: (r) => { setFound(r); setPicked(new Set(r.families.filter((x) => !x.inspecting).map((x) => x.id))); },
  });
  const ids = preset ? [preset.id] : [...picked];
  const assign = useMutation({
    mutationFn: () => api<{ created: number; skipped: { familyNo: string; reason: string }[] }>('/inspections', {
      method: 'POST', body: { familyIds: ids, inspectorIds: [a.first, a.second].filter(Boolean), mode: a.mode, ...(a.note.trim() ? { note: a.note.trim() } : {}) },
    }),
    onSuccess: (r) => {
      toast(r.created ? `كُلّف بكشف ${r.created === 1 ? 'عائلة واحدة' : `${r.created} عائلة`}. يصل هاتف الكاشف عند مزامنته.` : 'لم يُكلَّف بشيء', r.created ? 'ok' : 'info');
      refreshAll(queryClient);
      if (r.skipped.length) setSkipped(r.skipped); else onClose();
    },
  });
  const name = (u: Inspector) => `${u.fullName} (${ROLE[u.role] ?? u.role}${u.open ? `، عليه ${u.open}` : ''})`;
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Dialog open={open} title={preset ? `تكليف بكشف العائلة ${preset.familyNo}` : 'تكليف بالكشف الميداني'} onClose={onClose} wide>
      {skipped ? (
        <>
          <Alert tone="warn"><strong>تُخطّي {skipped.length} من العوائل:</strong><ul className="list-inside list-disc font-normal">{skipped.map((s) => <li key={s.familyNo}>العائلة <bdi>{s.familyNo}</bdi>: {s.reason}</li>)}</ul></Alert>
          <div className="flex justify-end"><Button onClick={onClose}>تمّ</Button></div>
        </>
      ) : (
        <>
          {!preset && (
            <>
              <Segmented label="طريقة اختيار العوائل" value={how} onChange={(v) => { setHow(v); setFound(null); }} options={[['filter', 'بالتصفية'], ['numbers', 'بأرقام العوائل']]} />
              {how === 'filter' ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <Field label="حال العائلة">{(id) => <Select id={id} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="ANY">الكل</option><option value="APPROVED">معتمدة</option><option value="PENDING">بانتظار الاعتماد</option></Select>}</Field>
                  <Field label="الكشف">{(id) => <Select id={id} value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}><option value="NONE">غير مكشوفة</option><option value="DONE">مكشوفة (إعادة كشف)</option><option value="ANY">الكل</option></Select>}</Field>
                  <Field label="المحلة">{(id) => <Input id={id} value={f.mahalla} onChange={(e) => setF({ ...f, mahalla: e.target.value })} />}</Field>
                  <Field label="الفئة">{(id) => <Select id={id} value={f.cls} onChange={(e) => setF({ ...f, cls: e.target.value })}><option value="">الكل</option>{Object.entries(CLASS_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
                  <Field label="أقصى عدد">{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value.replace(/\D/g, '') })} />}</Field>
                </div>
              ) : (
                <Field label="أرقام العوائل" hint="افصل بينها بمسافة أو فاصلة أو سطر">{(id) => <textarea id={id} rows={2} dir="ltr" value={f.numbers} onChange={(e) => setF({ ...f, numbers: e.target.value })} className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5" />}</Field>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="secondary" loading={search.isPending} disabled={how === 'numbers' && !f.numbers.trim()} onClick={() => search.mutate()}>اعرض العوائل</Button>
                {found && <span className="text-muted" data-testid="picked">{picked.size} مختارة من {found.families.length}</span>}
              </div>
              {search.error && <Alert>{search.error.message}</Alert>}
              {found?.unknown.length ? <Alert tone="warn">لا عائلة قائمة بهذه الأرقام: <bdi>{found.unknown.join('، ')}</bdi></Alert> : null}
              {found && found.families.length === 0 && <p className="text-muted">لا عائلة تطابق. الأقدم بلا كشف يأتي أولاً.</p>}
              {found && found.families.length > 0 && (
                <ul className="flex max-h-56 flex-col overflow-y-auto rounded-xl border border-line">
                  {found.families.map((x) => (
                    <li key={x.id} className="border-b border-line last:border-0">
                      <label className={cn('flex cursor-pointer items-center gap-3 px-3 py-2', x.inspecting && 'cursor-not-allowed opacity-60')}>
                        <input type="checkbox" className="size-5 accent-[#0f6b5c]" disabled={x.inspecting} checked={picked.has(x.id)} onChange={() => toggle(x.id)} />
                        <span className="font-semibold tabular-nums"><bdi>{x.familyNo}</bdi></span><span className="min-w-0 flex-1 truncate">{x.headName ?? '—'}</span>
                        <span className="text-sm text-muted">{x.mahalla ?? ''}{x.class ? ` · ${CLASS_AR[x.class]} ${x.points}` : ''}</span>
                        {x.inspecting ? <Badge tone="info">عليها كشف قائم</Badge> : x.inspectedAt ? <Badge tone="ok">كُشفت {formatAgo(x.inspectedAt)}</Badge> : <Badge>غير مكشوفة</Badge>}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {preset && <p><strong>{preset.headName ?? '—'}</strong> · العائلة <bdi>{preset.familyNo}</bdi></p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="الكاشف">{(id) => <Select id={id} value={a.first} onChange={(e) => setA({ ...a, first: e.target.value, second: a.second === e.target.value ? '' : a.second })}><option value="">اختر متعهداً أو باحثاً</option>{inspectors.data?.map((u) => <option key={u.id} value={u.id}>{name(u)}</option>)}</Select>}</Field>
            <Field label="كاشف ثانٍ (اختياري)">{(id) => <Select id={id} value={a.second} disabled={!a.first} onChange={(e) => setA({ ...a, second: e.target.value })}><option value="">كاشف واحد</option>{inspectors.data?.filter((u) => u.id !== a.first).map((u) => <option key={u.id} value={u.id}>{name(u)}</option>)}</Select>}</Field>
          </div>
          {a.second && !preset && (
            <div className="flex flex-wrap items-center gap-3">
              <Segmented label="عمل الكاشفَين" value={a.mode} onChange={(v) => setA({ ...a, mode: v })} options={[['BOTH', 'كلاهما يكشف كل عائلة'], ['SPLIT', 'تُقسم العوائل بينهما']]} />
              <span className="text-sm text-muted">{a.mode === 'BOTH' ? 'شهادتان مستقلتان على كل عائلة: كلٌّ يرفع تقريره من هاتفه.' : 'كل عائلة يكشفها واحد منهما، بالتناوب.'}</span>
            </div>
          )}
          {a.second && preset && <p className="text-sm text-muted">شهادتان مستقلتان: كلٌّ يرفع تقريره من هاتفه، وترى ما اتفقا عليه وما اختلفا.</p>}
          <Field label="ما تريد التحقق منه خاصة (اختياري)">{(id) => <Input id={id} value={a.note} onChange={(e) => setA({ ...a, note: e.target.value })} />}</Field>
          <p className="text-sm text-muted">من سجّل العائلة لا يكشفها: تُتخطّى إن لم يبقَ لها كاشف غيره.</p>
          {assign.error && <Alert>{assign.error.message}</Alert>}
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="secondary" onClick={onClose}>إلغاء</Button>
            <Button loading={assign.isPending} disabled={!a.first || ids.length === 0} onClick={() => assign.mutate()}><ClipboardCheck aria-hidden="true" className="size-4" />{preset ? 'كلّف بالكشف' : `كلّف بكشف ${ids.length} عائلة`}</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

/** الكشف الميداني في ملف العائلة: حالها منه، وسجل كشوفها بمن قام بها وما آلت إليه. */
export function FamilyInspections({ familyId, familyNo, headName, status, inspectedAt, delta }: { familyId: string; familyNo: string; headName: string | null; status: FamilyStatus; inspectedAt: string | null; delta: number }) {
  const { user } = useAuth();
  const list = useQuery({ queryKey: ['inspections', 'family', familyId], queryFn: () => api<Inspection[]>(`/inspections?familyId=${familyId}`) });
  const [openId, setOpenId] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const rows = list.data ?? [];
  const busy = rows.some((i) => i.status === 'ASSIGNED' || i.status === 'SUBMITTED');
  const canAssign = !!user && INSPECTION_DECIDERS.includes(user.role) && !busy && status !== 'REJECTED' && status !== 'REMOVED';
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex-1 text-lg font-bold">الكشف الميداني</h2>
        {inspectedAt ? <Badge tone="ok">مكشوفة · {formatAgo(inspectedAt)}</Badge> : busy ? <Badge tone="info">قيد الكشف</Badge> : <Badge>غير مكشوفة</Badge>}
        {delta !== 0 && <Badge tone={delta > 0 ? 'info' : 'warn'}>تعديل الكشف على نقاطها: {deltaText(delta)}</Badge>}
        {canAssign && <Button variant="secondary" onClick={() => setAssigning(true)}>{inspectedAt ? 'أعد كشفها' : 'كلّف بكشفها'}</Button>}
      </div>
      {list.error && <Alert>{list.error.message}</Alert>}
      {list.isSuccess && rows.length === 0 && <p className="text-muted">لم يُكلَّف أحد بكشف هذه العائلة بعد. الكشف يطابق ما سُجّل بما في الواقع، وقد يرفع نقاطها أو يخفضها.</p>}
      <ul className="flex flex-col">{rows.map((i) => <InspectionRow key={i.id} i={i} withFamily={false} onOpen={() => setOpenId(i.id)} />)}</ul>
      <InspectionDialog id={openId} onClose={() => setOpenId(null)} />
      <AssignDialog open={assigning} onClose={() => setAssigning(false)} preset={{ id: familyId, familyNo, headName }} />
    </Card>
  );
}

/** أثر الكشوف المعتمدة: شارة لكل أثر بعدده ونسبته. */
export function EffectChips({ decided }: { decided: { approved: number; none: number; raised: number; lowered: number; removed: number } }) {
  const rows: [Effect, string, number][] = [['NONE', 'بلا أثر', decided.none], ['RAISED', 'رفع النقاط', decided.raised], ['LOWERED', 'خفض النقاط', decided.lowered], ['REMOVED', 'شطب', decided.removed]];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {rows.map(([key, label, n]) => (
        <div key={key} className="rounded-xl border border-line p-3">
          <Badge tone={EFFECT_TONE[key]}>{label}</Badge>
          <div className="pt-1.5 text-2xl font-bold tabular-nums">{formatNumber(n)}</div>
          <div className="text-sm text-muted">{decided.approved ? `${Math.round((n / decided.approved) * 100)}%` : '—'} من المعتمد</div>
        </div>
      ))}
    </div>
  );
}

