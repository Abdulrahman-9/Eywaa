import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Attachments } from '../components/Attachments';
import { ChangeDialog } from '../components/ChangeDialog';
import { FamilyMessages, MESSAGE_READERS } from '../components/FamilyMessages';
import { FamilyInspections, INSPECTION_READERS, deltaText } from '../components/Inspections';
import { FamilyReassessments } from '../components/Reassessments';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { age, formatDateTime, formatNumber } from '../lib/format';
import { CHANGE_STATUS, CHANGE_TYPES, DOC_TYPES, FAMILY_STATUS, HOUSING, INCOME_KINDS, RELATIONS, TAGS } from '../lib/labels';
import type { ChangeRequest, Family as FamilyT, ScoreLine } from '../lib/types';
import { CLASS_AR } from './Scoring';
import { Qr } from './Tokens';

const DECIDERS = ['ADMIN', 'BENEFICIARY_SUPERVISOR'];
const EDITORS = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><span className="text-muted">{label}: </span>{children}</div>;
}

export function Family() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'approve' | 'reject' | 'change' | 'restore' | null>(null);
  const family = useQuery({ queryKey: ['family', id], queryFn: () => api<FamilyT>(`/families/${id}`) });
  const score = useQuery({ queryKey: ['family', id, 'score'], queryFn: () => api<{ version: number; points: number; class: string; breakdown: ScoreLine[]; base: number; adjustment: number } | null>(`/families/${id}/score`) });
  const entitlements = useQuery({
    queryKey: ['family', id, 'entitlements'],
    queryFn: () => api<{ programId: string; name: string; unit: string; eligible: boolean; quantity: number; reasons: string[] }[]>(`/families/${id}/entitlements`),
  });
  const deliveries = useQuery({
    queryKey: ['family', id, 'deliveries'],
    queryFn: () => api<{ entitlementId: string; campaignName: string; quantity: number; unit: string; status: string; deliveredAt: string | null; point: string; receiver: string | null; receiverName: string | null }[]>(`/families/${id}/deliveries`),
  });
  const changes = useQuery({ queryKey: ['changes', id], queryFn: () => api<ChangeRequest[]>(`/changes?familyId=${id}`) });

  const decide = useMutation({
    mutationFn: (v: { verb: 'approve' | 'reject'; note: string }) => api(`/families/${id}/${v.verb}`, { method: 'POST', body: v.note ? { note: v.note } : {} }),
    onSuccess: (_d, v) => {
      toast(v.verb === 'approve' ? 'اعتُمدت العائلة' : 'رُفض السجل');
      setDialog(null);
      for (const key of ['family', 'families', 'overview']) queryClient.invalidateQueries({ queryKey: [key] });
    },
  });

  const restore = useMutation({
    mutationFn: (note: string) => api(`/families/${id}/restore`, { method: 'POST', body: { note } }),
    onSuccess: () => { toast('أُعيدت العائلة إلى المستفيدين وحُسبت نقاطها'); setDialog(null); for (const key of ['family', 'families', 'overview', 'inspections']) queryClient.invalidateQueries({ queryKey: [key] }); },
  });

  if (family.isPending) return <Skeleton className="h-40 w-full" />;
  if (family.error) return <Alert>{family.error.message}</Alert>;
  const f = family.data;
  const head = f.members.find((m) => m.relation === 'HEAD');
  const mine = f.createdBy === user?.username;
  const pending = f.status === 'PENDING_APPROVAL' || f.status === 'PENDING_DEDUPE_REVIEW';
  const canDecide = !!user && DECIDERS.includes(user.role) && pending;
  const canEdit = !!user && EDITORS.includes(user.role) && f.status !== 'REJECTED' && f.status !== 'REMOVED';
  const openFlags = f.duplicateFlags.filter((x) => x.status === 'OPEN');
  const pendingChanges = (changes.data ?? []).filter((c) => c.status === 'PENDING');

  return (
    <>
      {/* بطاقة العائلة: لا تظهر إلا في الطباعة. تعريف بالعائلة، وليست رمز استلام. */}
      <article aria-hidden="true" className="hidden w-[9.5cm] flex-col gap-3 rounded-xl border-2 border-black p-4 text-black print:flex">
        <div className="flex items-center justify-between border-b border-black pb-2"><strong className="text-xl">إيواء</strong><span>بطاقة عائلة</span></div>
        <div className="flex items-center gap-4">
          <Qr value={f.familyNo} label="رقم العائلة" />
          <div className="flex min-w-0 flex-col gap-1">
            <strong className="text-lg leading-snug">{head?.fullName}</strong>
            <span>رقم العائلة: <strong className="text-xl tabular-nums">{f.familyNo}</strong></span>
            <span>الأفراد: <strong>{f.members.filter((m) => m.status === 'ACTIVE').length}</strong>{f.address.mahalla && <> · {f.address.mahalla}</>}</span>
          </div>
        </div>
        <div className="text-sm">يستلم عنها: رب الأسرة{f.proxies.some((p) => p.active) && <>، أو {f.proxies.filter((p) => p.active).map((p) => p.fullName).join('، ')}</>}.</div>
        <div className="border-t border-black pt-2 text-xs">هذه البطاقة تعريف بالعائلة. الاستلام برمز الحملة الذي يصلكم برسالة أو ببطاقة.</div>
      </article>
      <div className="contents print:hidden">
      <Card className="flex flex-wrap items-center gap-4">
        <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-1">
          <Link to="/families" className="text-sm font-semibold text-brand-strong">العوائل ←</Link>
          <h1 className="text-2xl font-bold">{head?.fullName ?? '—'}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tabular-nums">العائلة {f.familyNo}</span>
            <Badge tone={FAMILY_STATUS[f.status].tone}>{FAMILY_STATUS[f.status].label}</Badge>
            {f.score && <span className="rounded-md bg-brand-strong px-2.5 py-0.5 text-sm font-bold text-white">الفئة {CLASS_AR[f.score.class]} · {f.score.points} نقطة</span>}
            {f.status !== 'REJECTED' && f.status !== 'REMOVED' && (f.inspectedAt ? <Badge tone="ok">مكشوفة</Badge> : <Badge>غير مكشوفة</Badge>)}
            {f.tags.map((t) => <Badge key={t}>{TAGS[t]}</Badge>)}
          </div>
        </div>
        {f.status === 'APPROVED' && <Button variant="secondary" onClick={() => window.print()}>اطبع البطاقة</Button>}
        {canEdit && <Button variant="secondary" onClick={() => setDialog('change')}>طلب تعديل</Button>}
        {canDecide && !mine && (
          <>
            <Button variant="danger" onClick={() => setDialog('reject')}>رفض السجل</Button>
            <Button disabled={f.status === 'PENDING_DEDUPE_REVIEW'} onClick={() => setDialog('approve')}>اعتماد</Button>
          </>
        )}
      </Card>

      {pending && mine && <Alert tone="warn"><strong>هذا السجل أدخلتَه أنت.</strong> اعتماده لموظف آخر، ليشهد اثنان على كل عائلة تدخل النظام.</Alert>}
      {openFlags.length > 0 && (
        <Alert tone="warn">
          <strong>في السجل {openFlags.length === 1 ? 'شبهة تكرار' : `${openFlags.length} شبهات تكرار`} لم يُفصل فيها.</strong> لا يُعتمد قبل الفصل.{' '}
          <Link to="/review?tab=flags" className="font-bold underline">راجع الشبهات</Link>
        </Alert>
      )}
      {pendingChanges.length > 0 && (
        <Alert tone="warn"><strong>{pendingChanges.length === 1 ? 'طلب تعديل ينتظر' : `${pendingChanges.length} طلبات تعديل تنتظر`} الاعتماد.</strong> لا تسري حتى تُعتمد. <Link to="/review?tab=changes" className="font-bold underline">راجعها</Link></Alert>
      )}
      {f.status === 'REJECTED' && <Alert><strong>سجل مرفوض.</strong> {f.decisionNote} (بقرار {f.decidedBy})</Alert>}
      {f.removal && (
        <Alert>
          <strong>عائلة مشطوبة من المستفيدين.</strong> {f.removal.note} (بقرار {f.removal.by} · {formatDateTime(f.removal.at)}). سجلها باقٍ ووثائقها محجوزة، ولا تدخل حملة.
          {user && DECIDERS.includes(user.role) && f.removal.by !== user.username && <> <button type="button" className="font-bold underline" onClick={() => { restore.reset(); setDialog('restore'); }}>أعدها إلى المستفيدين</button></>}
        </Alert>
      )}
      {f.membersWithoutDocument.length > 0 && <Alert tone="warn"><strong>أفراد بلا وثيقة:</strong> {f.membersWithoutDocument.join('، ')}. تُستكمل بطلب «إضافة وثيقة».</Alert>}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[2_1_30rem] flex-col gap-5">
          <Card className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">الأفراد ({f.counts.members}: {f.counts.males} ذكور و{f.counts.females} إناث)</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] border-collapse text-sm">
                <thead><tr className="text-muted">{['الاسم', 'الصلة', 'العمر', 'الوثيقة', 'ملاحظة'].map((h) => <th key={h} scope="col" className="border-b border-line p-2 text-start font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {f.members.map((m) => (
                    <tr key={m.id} className="border-b border-line last:border-0">
                      <td className="p-2 font-semibold">{m.fullName}</td>
                      <td className="p-2">{RELATIONS[m.relation]}</td>
                      <td className="p-2">{m.status === 'DECEASED' ? 'متوفى' : age(m.birthDate)}</td>
                      <td className="p-2">{m.documents.length ? m.documents.map((d) => <div key={d.type + d.numberMasked}>{DOC_TYPES[d.type]} <span dir="ltr" className="tabular-nums text-muted">{d.numberMasked}</span></div>) : <span className="text-warn-ink">بلا وثيقة</span>}</td>
                      <td className="p-2">{[m.isOrphan && 'يتيم', m.disability, m.chronicIllness].filter(Boolean).join('، ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {deliveries.data && deliveries.data.length > 0 && (
            <Card className="flex flex-col gap-3">
              <h2 className="text-lg font-bold">ما استلمته العائلة</h2>
              <ul className="flex flex-col">
                {deliveries.data.map((d) => (
                  <li key={d.entitlementId} className="flex flex-wrap items-center gap-3 border-b border-line py-2.5 last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{d.quantity} {d.unit} · {d.campaignName}</div>
                      <div className="text-sm text-muted">{d.status === 'DELIVERED' ? `${d.point} · استلمها ${d.receiver === 'PROXY' ? 'الوكيل' : 'رب الأسرة'} ${d.receiverName}` : `بانتظار الاستلام من ${d.point}`}</div>
                    </div>
                    {d.deliveredAt ? <span className="text-sm text-muted">{formatDateTime(d.deliveredAt)}</span> : <Badge tone="warn">لم تستلم بعد</Badge>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">المرفقات</h2>
            <Attachments familyId={f.id} canUpload={canEdit} canDelete={!!user && DECIDERS.includes(user.role)} />
          </Card>

          <Card className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">طلبات التعديل</h2>
            {changes.data?.length === 0 && <p className="text-muted">لم يُطلب تعديل على هذا السجل.</p>}
            <ul className="flex flex-col">
              {changes.data?.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 border-b border-line py-2.5 last:border-0">
                  <div className="min-w-0 flex-1"><div className="font-semibold">{CHANGE_TYPES[c.type]}</div><div className="text-sm text-muted">{c.reason} · طلبه {c.requestedBy} · {formatDateTime(c.requestedAt)}</div></div>
                  <Badge tone={CHANGE_STATUS[c.status].tone}>{CHANGE_STATUS[c.status].label}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-5">
          {score.data && (
            <Card className="flex flex-col gap-2">
              <h2 className="text-lg font-bold">لماذا {score.data.points} نقطة؟</h2>
              <ul className="flex flex-col gap-1.5 text-sm">
                {score.data.breakdown.map((l) => (
                  <li key={l.key} className="flex justify-between gap-3"><span>{l.label} <span className="text-muted">({l.why})</span></span><strong className="flex-none tabular-nums">{l.got} / {l.max}</strong></li>
                ))}
              </ul>
              {score.data.adjustment !== 0 && (
                <ul className="flex flex-col gap-1.5 border-t border-line pt-2 text-sm" data-testid="score-adjustment">
                  <li className="flex justify-between gap-3"><span>مجموع المعادلة</span><strong className="tabular-nums">{score.data.base}</strong></li>
                  <li className="flex justify-between gap-3"><span>تعديل الكشف الميداني <span className="text-muted">(بقرار معتمَد)</span></span><strong className={`tabular-nums ${score.data.adjustment > 0 ? 'text-info-ink' : 'text-warn-ink'}`}>{deltaText(score.data.adjustment)}</strong></li>
                </ul>
              )}
              <p className="border-t border-line pt-2 text-sm text-muted">الفئة {CLASS_AR[score.data.class]}، بالإصدار {score.data.version} من المعادلة.</p>
            </Card>
          )}
          {f.status === 'APPROVED' && entitlements.data && entitlements.data.length > 0 && (
            <Card className="flex flex-col gap-2.5">
              <h2 className="text-lg font-bold">يستحق الآن</h2>
              {entitlements.data.map((e) => (
                <div key={e.programId} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-3"><span className="font-semibold">{e.name}</span>{e.eligible ? <Badge tone="ok">{formatNumber(e.quantity)} {e.unit}</Badge> : <Badge>غير مستحق</Badge>}</div>
                  {!e.eligible && <span className="text-sm text-muted">{e.reasons.join('، ')}</span>}
                </div>
              ))}
            </Card>
          )}
          <Card className="flex flex-col gap-2">
            <h2 className="text-lg font-bold">الدخل وخط الفقر</h2>
            {f.incomes.length === 0 && <p className="text-muted">لا دخل مسجَّل.</p>}
            {f.incomes.map((i, n) => <div key={n} className="flex justify-between gap-3"><span>{INCOME_KINDS[i.kind]}</span><strong className="tabular-nums">{formatNumber(i.amountIqd)}</strong></div>)}
            <div className="flex justify-between gap-3 border-t border-line pt-2"><span>دخل الفرد في الشهر</span><strong className="tabular-nums">{f.perCapitaIncomeIqd === null ? '—' : formatNumber(f.perCapitaIncomeIqd)}</strong></div>
            {f.belowPovertyLine !== null && (
              <Badge tone={f.belowPovertyLine ? 'ok' : 'warn'}>{f.belowPovertyLine ? 'دون خط الفقر' : 'فوق خط الفقر'} ({formatNumber(f.povertyLineIqd)})</Badge>
            )}
          </Card>
          <Card className="flex flex-col gap-1.5">
            <h2 className="text-lg font-bold">السكن والاتصال</h2>
            <Row label="العنوان">{[f.address.mahalla, f.address.street, f.address.house, f.address.landmark].filter(Boolean).join('، ') || '—'}</Row>
            <Row label="نوع العقار">{f.housing ? HOUSING[f.housing] : '—'}</Row>
            <Row label="الهاتف"><span dir="ltr">{f.phone1 ?? '—'}</span></Row>
            <Row label="البطاقة التموينية"><span dir="ltr">{f.rationCard?.numberMasked ?? '—'}</span></Row>
          </Card>
          <Card className="flex flex-col gap-1.5">
            <h2 className="text-lg font-bold">الوكلاء</h2>
            {f.proxies.filter((p) => p.active).length === 0 && <p className="text-muted">لا وكيل. لا يستلم إلا رب الأسرة.</p>}
            {f.proxies.filter((p) => p.active).map((p) => <div key={p.id}><strong>{p.fullName}</strong>{p.relation ? ` (${p.relation})` : ''}</div>)}
          </Card>
          <Card className="flex flex-col gap-1.5 text-sm text-muted">
            <div>أدخله {f.createdBy} · {formatDateTime(f.createdAt)}</div>
            {f.decidedBy && f.decidedAt && <div>{f.status === 'REJECTED' ? 'رفضه' : 'اعتمده'} {f.decidedBy} · {formatDateTime(f.decidedAt)}</div>}
          </Card>
        </div>
      </div>

      {user && INSPECTION_READERS.includes(user.role) && <FamilyInspections familyId={f.id} familyNo={f.familyNo} headName={head?.fullName ?? null} status={f.status} inspectedAt={f.inspectedAt} delta={f.inspectionDelta} />}
      {user && MESSAGE_READERS.includes(user.role) && f.status === 'APPROVED' && <FamilyMessages familyId={f.id} familyNo={f.familyNo} hasPhone={!!f.phone1} />}
      {user && ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'AUDITOR'].includes(user.role) && f.status === 'APPROVED' && <FamilyReassessments familyId={f.id} familyNo={f.familyNo} approved />}
      <ReasonDialog open={dialog === 'approve'} title={`اعتماد العائلة ${f.familyNo}`} confirmLabel="اعتماد" required={false}
        pending={decide.isPending} error={decide.error?.message} onClose={() => { decide.reset(); setDialog(null); }}
        onConfirm={(note) => decide.mutate({ verb: 'approve', note })}>
        <p>تدخل العائلة في النظام معتمدة، وتُحسب استحقاقاتها. شهادتك على صحة السجل تُحفظ باسمك.</p>
      </ReasonDialog>
      <ReasonDialog open={dialog === 'reject'} title={`رفض سجل العائلة ${f.familyNo}`} confirmLabel="رفض السجل" danger
        pending={decide.isPending} error={decide.error?.message} onClose={() => { decide.reset(); setDialog(null); }}
        onConfirm={(note) => decide.mutate({ verb: 'reject', note })}>
        <p>يبقى السجل للتاريخ، وتتحرر وثائقه لتسجيل لاحق صحيح.</p>
      </ReasonDialog>
      <ReasonDialog open={dialog === 'restore'} title={`إعادة العائلة ${f.familyNo} إلى المستفيدين`} confirmLabel="أعد العائلة"
        pending={restore.isPending} error={restore.error?.message} onClose={() => setDialog(null)} onConfirm={(note) => restore.mutate(note)}>
        <p>تعود معتمدة وتُحسب نقاطها من جديد. ما سقط من استحقاقها في الحملات لا يعود من نفسه. لا يعيدها من شطبها.</p>
      </ReasonDialog>
      <ChangeDialog family={f} open={dialog === 'change'} onClose={() => setDialog(null)} />
      </div>
    </>
  );
}
