import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Attachments } from '../components/Attachments';
import { ChangeDialog } from '../components/ChangeDialog';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { age, formatDateTime, formatNumber } from '../lib/format';
import { CHANGE_STATUS, CHANGE_TYPES, DOC_TYPES, FAMILY_STATUS, HOUSING, INCOME_KINDS, RELATIONS, TAGS } from '../lib/labels';
import type { ChangeRequest, Family as FamilyT } from '../lib/types';

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
  const [dialog, setDialog] = useState<'approve' | 'reject' | 'change' | null>(null);
  const family = useQuery({ queryKey: ['family', id], queryFn: () => api<FamilyT>(`/families/${id}`) });
  const changes = useQuery({ queryKey: ['changes', id], queryFn: () => api<ChangeRequest[]>(`/changes?familyId=${id}`) });

  const decide = useMutation({
    mutationFn: (v: { verb: 'approve' | 'reject'; note: string }) => api(`/families/${id}/${v.verb}`, { method: 'POST', body: v.note ? { note: v.note } : {} }),
    onSuccess: (_d, v) => {
      toast(v.verb === 'approve' ? 'اعتُمدت العائلة' : 'رُفض السجل');
      setDialog(null);
      for (const key of ['family', 'families', 'overview']) queryClient.invalidateQueries({ queryKey: [key] });
    },
  });

  if (family.isPending) return <Skeleton className="h-40 w-full" />;
  if (family.error) return <Alert>{family.error.message}</Alert>;
  const f = family.data;
  const head = f.members.find((m) => m.relation === 'HEAD');
  const mine = f.createdBy === user?.username;
  const pending = f.status === 'PENDING_APPROVAL' || f.status === 'PENDING_DEDUPE_REVIEW';
  const canDecide = !!user && DECIDERS.includes(user.role) && pending;
  const canEdit = !!user && EDITORS.includes(user.role) && f.status !== 'REJECTED';
  const openFlags = f.duplicateFlags.filter((x) => x.status === 'OPEN');
  const pendingChanges = (changes.data ?? []).filter((c) => c.status === 'PENDING');

  return (
    <>
      <Card className="flex flex-wrap items-center gap-4">
        <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-1">
          <Link to="/families" className="text-sm font-semibold text-brand-strong">العوائل ←</Link>
          <h1 className="text-2xl font-bold">{head?.fullName ?? '—'}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tabular-nums">العائلة {f.familyNo}</span>
            <Badge tone={FAMILY_STATUS[f.status].tone}>{FAMILY_STATUS[f.status].label}</Badge>
            {f.tags.map((t) => <Badge key={t}>{TAGS[t]}</Badge>)}
          </div>
        </div>
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
      <ChangeDialog family={f} open={dialog === 'change'} onClose={() => setDialog(null)} />
    </>
  );
}
