import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, PageHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime } from '../lib/format';
import { CHANGE_TYPES, DOC_TYPES, fieldLabel, HOUSING } from '../lib/labels';
import type { ChangeRequest, Family, FamilyRow, OpenFlag } from '../lib/types';

type Tab = 'approvals' | 'flags' | 'changes';

function Empty({ text }: { text: string }) {
  return <Card className="flex flex-col items-center gap-2 py-10 text-center"><strong className="text-lg">لا شيء ينتظر قرارك</strong><span className="text-muted">{text}</span></Card>;
}

function Compare({ flag, onDone }: { flag: OpenFlag; onDone: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<'DISMISS' | 'CONFIRM' | null>(null);
  const a = useQuery({ queryKey: ['family', flag.familyId], queryFn: () => api<Family>(`/families/${flag.familyId}`) });
  const b = useQuery({ queryKey: ['family', flag.matchedFamilyId], queryFn: () => api<Family>(`/families/${flag.matchedFamilyId}`) });
  const resolve = useMutation({
    mutationFn: (note: string) => api(`/duplicate-flags/${flag.id}/resolve`, { method: 'POST', body: { decision, note } }),
    onSuccess: () => {
      toast(decision === 'CONFIRM' ? 'أُكّد التكرار ورُفض السجل الجديد' : 'صُرفت الشبهة');
      setDecision(null);
      for (const key of ['flags', 'family', 'families', 'overview']) queryClient.invalidateQueries({ queryKey: [key] });
      onDone();
    },
  });
  if (a.isPending || b.isPending) return <Skeleton className="h-64 w-full" />;
  if (a.error || b.error) return <Alert>{(a.error ?? b.error)!.message}</Alert>;
  const pa = a.data.members.find((m) => m.fullName === flag.personName) ?? a.data.members[0];
  const pb = b.data.members.find((m) => m.fullName === flag.matchedPersonName) ?? b.data.members[0];
  const doc = (m: typeof pa) => m.documents.map((d) => `${DOC_TYPES[d.type]} ${d.numberMasked}`).join('، ') || 'بلا وثيقة';
  const rows: [string, string, string][] = [
    ['الاسم', pa.fullName, pb.fullName],
    ['اسم الأم', pa.motherName ?? '—', pb.motherName ?? '—'],
    ['المواليد', pa.birthDate ? formatDate(pa.birthDate) : '—', pb.birthDate ? formatDate(pb.birthDate) : '—'],
    ['الوثيقة', doc(pa), doc(pb)],
    ['الهاتف', a.data.phone1 ?? '—', b.data.phone1 ?? '—'],
    ['المحلة', a.data.address.mahalla ?? '—', b.data.address.mahalla ?? '—'],
    ['نوع العقار', a.data.housing ? HOUSING[a.data.housing] : '—', b.data.housing ? HOUSING[b.data.housing] : '—'],
    ['عدد الأفراد', String(a.data.counts.members), String(b.data.counts.members)],
    ['أدخله', `${formatDate(a.data.createdAt)} · ${a.data.createdBy}`, `${formatDate(b.data.createdAt)} · ${b.data.createdBy}`],
  ];
  const mine = a.data.createdBy === user?.username;
  return (
    <Card className="flex min-w-0 flex-[3_1_32rem] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="text-xl font-bold">أهما شخص واحد؟</h2>
        <Badge tone="info">تشابه الاسم {Math.round(flag.score * 100)}%</Badge>
      </div>
      <p className="text-muted">{flag.reason}. الوثيقتان مختلفتان، ولذلك لم يُمنع التسجيل وأُحيل إليك. الفروق مُعلَّمة.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[38rem] border-collapse">
          <thead><tr>
            <th scope="col" className="w-1/4 border-b border-line p-2.5"><span className="sr-only">الحقل</span></th>
            <th scope="col" className="border-b border-line p-2.5 text-start">السجل الجديد <Link className="font-semibold text-brand-strong" to={`/families/${a.data.id}`}>{a.data.familyNo}</Link></th>
            <th scope="col" className="border-b border-line p-2.5 text-start">السجل القائم <Link className="font-semibold text-brand-strong" to={`/families/${b.data.id}`}>{b.data.familyNo}</Link></th>
          </tr></thead>
          <tbody>
            {rows.map(([label, x, y]) => {
              const diff = x !== y;
              return (
                <tr key={label}>
                  <th scope="row" className="border-b border-line p-2.5 text-start font-medium text-muted">{label}</th>
                  <td className={`border-b border-line p-2.5 ${diff ? 'bg-warn-soft font-semibold' : ''}`}><bdi>{x}</bdi>{diff && <span className="ms-2 text-xs font-medium text-warn-ink">يختلف</span>}</td>
                  <td className={`border-b border-line p-2.5 ${diff ? 'bg-warn-soft font-semibold' : ''}`}><bdi>{y}</bdi></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {mine
        ? <Alert tone="warn"><strong>السجل الجديد أدخلتَه أنت.</strong> الفصل في شبهته لموظف آخر.</Alert>
        : (
          <div className="flex flex-wrap justify-end gap-2.5">
            <Button variant="danger" onClick={() => setDecision('CONFIRM')}>تكرار مؤكَّد: ارفض الجديد</Button>
            <Button onClick={() => setDecision('DISMISS')}>ليسا شخصاً واحداً</Button>
          </div>
        )}
      <ReasonDialog open={decision !== null} danger={decision === 'CONFIRM'}
        title={decision === 'CONFIRM' ? 'تأكيد التكرار' : 'صرف الشبهة'}
        confirmLabel={decision === 'CONFIRM' ? 'ارفض السجل الجديد' : 'ليسا شخصاً واحداً'}
        pending={resolve.isPending} error={resolve.error?.message}
        onClose={() => { resolve.reset(); setDecision(null); }} onConfirm={(note) => resolve.mutate(note)}>
        <p>{decision === 'CONFIRM' ? `يُرفض السجل ${a.data.familyNo} ويبقى السجل ${b.data.familyNo} كما هو.` : 'تُصرف الشبهة، فإن لم تبقَ غيرها عاد السجل إلى صف الاعتماد.'}</p>
      </ReasonDialog>
    </Card>
  );
}

function payloadLines(c: ChangeRequest): string[] {
  const p = c.payload;
  if (c.type === 'SET_INCOMES') return [`${p.incomes.length} مصدر دخل، مجموعها ${p.incomes.reduce((s: number, i: { amountIqd: number }) => s + i.amountIqd, 0).toLocaleString('en-US')} دينار`];
  if (c.type === 'ADD_MEMBER') return [`إضافة: ${p.member.fullName}`];
  if (c.type === 'ADD_DOCUMENT') return [`${DOC_TYPES[p.document.type as keyof typeof DOC_TYPES]} ${p.document.number}`];
  if (c.type === 'SET_PROXIES') return [`الوكلاء: ${p.proxies.map((x: { fullName: string }) => x.fullName).join('، ') || 'لا أحد'}`];
  return Object.entries(p).filter(([k]) => k !== 'personId').map(([k, v]) => `${fieldLabel(k)}: ${v === null ? 'يُمحى' : v === true ? 'نعم' : v === false ? 'لا' : v === 'DECEASED' ? 'متوفى' : v === 'ACTIVE' ? 'حيّ' : HOUSING[v as keyof typeof HOUSING] ?? String(v)}`);
}

export function Review() {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'approvals';
  const [selected, setSelected] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ change: ChangeRequest; approve: boolean } | null>(null);

  const approvals = useQuery({ queryKey: ['families', 'pending'], queryFn: () => api<FamilyRow[]>('/families?status=PENDING_APPROVAL&limit=200') });
  const flags = useQuery({ queryKey: ['flags'], queryFn: () => api<OpenFlag[]>('/duplicate-flags') });
  const changes = useQuery({ queryKey: ['changes', 'pending'], queryFn: () => api<ChangeRequest[]>('/changes?status=PENDING') });
  const decideChange = useMutation({
    mutationFn: (note: string) => api(`/changes/${deciding!.change.id}/${deciding!.approve ? 'approve' : 'reject'}`, { method: 'POST', body: note ? { note } : {} }),
    onSuccess: () => {
      toast(deciding!.approve ? 'اعتُمد التعديل وسرى' : 'رُفض التعديل');
      setDeciding(null);
      for (const key of ['changes', 'family', 'overview']) queryClient.invalidateQueries({ queryKey: [key] });
    },
  });

  const flag = flags.data?.find((x) => x.id === selected) ?? flags.data?.[0];
  const tabs: [Tab, string, number | undefined][] = [
    ['approvals', 'اعتماد التسجيل', approvals.data?.length],
    ['flags', 'شبهات التكرار', flags.data?.length],
    ['changes', 'طلبات التعديل', changes.data?.length],
  ];

  return (
    <>
      <PageHeader title="ينتظر قرارك" description="ما أدخلتَه بنفسك يعتمده غيرك." />
      <div role="tablist" aria-label="أنواع القرارات" className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map(([key, label, count]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setParams({ tab: key })}
            className={`min-h-11 border-b-[3px] px-4 ${tab === key ? 'border-brand font-bold text-brand-strong' : 'border-transparent font-medium text-muted'}`}>
            {label}{count !== undefined ? ` (${count})` : ''}
          </button>
        ))}
      </div>

      {tab === 'approvals' && (
        approvals.isPending ? <Skeleton className="h-32 w-full" />
          : approvals.error ? <Alert>{approvals.error.message}</Alert>
          : approvals.data.length === 0 ? <Empty text="اعتُمدت كل السجلات. ما يرد منها يظهر هنا." />
          : (
            <Card className="p-0">
              <ul>
                {approvals.data.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0">
                    <span className="font-semibold tabular-nums">{f.familyNo}</span>
                    <span className="min-w-0 flex-1 font-semibold">{f.headName}</span>
                    <span className="text-sm text-muted">{f.members} أفراد · {formatDateTime(f.createdAt)}</span>
                    <Link to={`/families/${f.id}`} className="inline-flex min-h-9 items-center rounded-lg border border-line-strong px-3.5 font-semibold hover:bg-ground">مراجعة</Link>
                  </li>
                ))}
              </ul>
            </Card>
          )
      )}

      {tab === 'flags' && (
        flags.isPending ? <Skeleton className="h-32 w-full" />
          : flags.error ? <Alert>{flags.error.message}</Alert>
          : !flag ? <Empty text="فُصل في كل الشبهات." />
          : (
            <div className="flex flex-wrap items-start gap-5">
              <Card className="min-w-0 flex-[1_1_16rem] p-0">
                {flags.data.map((x) => (
                  <button key={x.id} type="button" aria-current={x.id === flag.id} onClick={() => setSelected(x.id)}
                    className={`flex w-full flex-col gap-0.5 border-b border-line px-4 py-3 text-start last:border-0 ${x.id === flag.id ? 'bg-brand-soft' : ''}`}>
                    <strong>{x.personName}</strong>
                    <span className="text-sm text-muted">العائلة {x.familyNo} · تشابه {Math.round(x.score * 100)}%</span>
                  </button>
                ))}
              </Card>
              <Compare key={flag.id} flag={flag} onDone={() => setSelected(null)} />
            </div>
          )
      )}

      {tab === 'changes' && (
        changes.isPending ? <Skeleton className="h-32 w-full" />
          : changes.error ? <Alert>{changes.error.message}</Alert>
          : changes.data.length === 0 ? <Empty text="لا طلبات تعديل معلّقة." />
          : (
            <div className="flex flex-col gap-3">
              {changes.data.map((c) => {
                const mine = c.requestedBy === user?.username;
                return (
                  <Card key={c.id} className="flex flex-wrap items-start gap-4">
                    <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2"><strong className="text-lg">{CHANGE_TYPES[c.type]}</strong><Link className="font-semibold text-brand-strong" to={`/families/${c.familyId}`}>العائلة {c.familyNo}</Link></div>
                      <ul className="list-inside list-disc">{payloadLines(c).map((l) => <li key={l}>{l}</li>)}</ul>
                      <span className="text-sm text-muted">السبب: {c.reason} · طلبه {c.requestedBy} · {formatDateTime(c.requestedAt)}</span>
                    </div>
                    {mine ? <Badge tone="warn">طلبك: يعتمده غيرك</Badge> : (
                      <div className="flex flex-wrap gap-2.5">
                        <Button variant="danger" onClick={() => setDeciding({ change: c, approve: false })}>رفض</Button>
                        <Button onClick={() => setDeciding({ change: c, approve: true })}>اعتماد التعديل</Button>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )
      )}

      <ReasonDialog open={deciding !== null} danger={deciding ? !deciding.approve : false} required={deciding ? !deciding.approve : false}
        title={deciding?.approve ? 'اعتماد التعديل' : 'رفض التعديل'} confirmLabel={deciding?.approve ? 'اعتماد التعديل' : 'رفض التعديل'}
        pending={decideChange.isPending} error={decideChange.error?.message}
        onClose={() => { decideChange.reset(); setDeciding(null); }} onConfirm={(note) => decideChange.mutate(note)}>
        <p>{deciding?.approve ? 'يسري التعديل فوراً على سجل العائلة، وتُحفظ القيم السابقة في سجل التدقيق.' : 'يبقى سجل العائلة كما هو.'}</p>
      </ReasonDialog>
    </>
  );
}
