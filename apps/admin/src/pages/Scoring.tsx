import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatNumber, digits } from '../lib/format';

type Criteria = Record<string, Record<string, number>>;
interface Thresholds { a: number; b: number; c: number }
interface Version {
  version: number; status: 'PENDING' | 'ACTIVE' | 'RETIRED' | 'REJECTED'; criteria: Criteria; thresholds: Thresholds;
  note: string | null; maxTotal: number; createdBy: string | null; createdAt: string; decidedBy: string | null; decisionNote: string | null;
}
interface Overview { active: Version; pending: Version | null; history: Version[]; classes: Record<string, number>; povertyLineIqd: number }
interface Simulation {
  families: number; changed: number; transitions: Record<string, number>; after: Record<string, number>; maxTotal: number;
  affected: { familyId: string; familyNo: string; headName: string; from: string; to: string; oldPoints: number; newPoints: number }[];
}

export const CLASS_AR: Record<string, string> = { A: 'أ', B: 'ب', C: 'ج', D: 'د' };
const ORDER = 'ABCD';
const STATUS = { PENDING: ['ينتظر الاعتماد', 'warn'], ACTIVE: ['سارٍ', 'ok'], RETIRED: ['سابق', 'neutral'], REJECTED: ['مرفوض', 'danger'] } as const;

/** كل خانة تُعدَّل: المعيار، والحقل فيه، وتسميتها. */
const FIELDS: { key: string; field: string; label: string; how: string }[] = [
  { key: 'income', field: 'max', label: 'دخل الفرد الشهري: الأقصى', how: 'يزيد كلما قلّ الدخل عن خط الفقر' },
  { key: 'orphans', field: 'perUnit', label: 'الأيتام: لكل يتيم', how: '' },
  { key: 'orphans', field: 'max', label: 'الأيتام: الأقصى', how: '' },
  { key: 'housing', field: 'OWNED', label: 'السكن: ملك', how: '' },
  { key: 'housing', field: 'RENTED', label: 'السكن: إيجار', how: '' },
  { key: 'housing', field: 'OTHER', label: 'السكن: أخرى أو بلا سكن ثابت', how: '' },
  { key: 'disabled', field: 'perUnit', label: 'ذوو الإعاقة: لكل فرد', how: '' },
  { key: 'disabled', field: 'max', label: 'ذوو الإعاقة: الأقصى', how: '' },
  { key: 'femaleHead', field: 'max', label: 'معيلة بلا معيل', how: 'أرملة أو مطلقة أو غير متزوجة' },
  { key: 'familySize', field: 'above', label: 'حجم الأسرة: يُحسب ما فوق', how: 'عدد الأفراد الذي لا نقاط دونه' },
  { key: 'familySize', field: 'perUnit', label: 'حجم الأسرة: لكل فرد زائد', how: '' },
  { key: 'familySize', field: 'max', label: 'حجم الأسرة: الأقصى', how: '' },
  { key: 'chronic', field: 'perUnit', label: 'المرض المزمن: لكل فرد', how: '' },
  { key: 'chronic', field: 'max', label: 'المرض المزمن: الأقصى', how: '' },
  { key: 'noIncome', field: 'max', label: 'لا راتب ولا إعانة', how: '' },
];

export function Scoring() {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ['scoring'], queryFn: () => api<Overview>('/scoring') });
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  const [thresholds, setThresholds] = useState<Thresholds | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [seen, setSeen] = useState(false);
  const [deciding, setDeciding] = useState<boolean | null>(null);
  const active = overview.data?.active;

  useEffect(() => {
    if (active && !criteria) { setCriteria(structuredClone(active.criteria)); setThresholds({ ...active.thresholds }); }
  }, [active, criteria]);

  const isAdmin = user?.role === 'ADMIN';
  const dirty = !!active && !!criteria && !!thresholds && (JSON.stringify(criteria) !== JSON.stringify(active.criteria) || JSON.stringify(thresholds) !== JSON.stringify(active.thresholds));
  const draftKey = JSON.stringify([criteria, thresholds]);
  const simulation = useQuery({
    queryKey: ['scoring-sim', draftKey],
    queryFn: () => api<Simulation>('/scoring/simulate', { method: 'POST', body: { criteria, thresholds } }),
    enabled: dirty && isAdmin,
    retry: false,
  });

  const refresh = () => { for (const k of ['scoring', 'overview', 'families', 'family']) queryClient.invalidateQueries({ queryKey: [k] }); };
  const propose = useMutation({
    mutationFn: () => api('/scoring/versions', { method: 'POST', body: { criteria, thresholds } }),
    onSuccess: () => { toast('أُرسل الإصدار إلى الاعتماد'); setConfirming(false); setCriteria(null); refresh(); },
  });
  const decide = useMutation({
    mutationFn: (note: string) => api(`/scoring/versions/${overview.data?.pending?.version}/${deciding ? 'approve' : 'reject'}`, { method: 'POST', body: note ? { note } : {} }),
    onSuccess: () => { toast(deciding ? 'اعتُمد الإصدار وأُعيد حساب النقاط' : 'رُفض الإصدار'); setDeciding(null); setCriteria(null); refresh(); },
  });

  const data = overview.data;
  if (!data || !criteria || !thresholds || !active) return overview.error ? <Alert>{overview.error.message}</Alert> : <Skeleton className="h-64 w-full" />;
  const { pending, classes, povertyLineIqd, history } = data;
  const total = Object.values(classes).reduce((a, b) => a + b, 0);
  const num = (v: string) => Math.max(0, Math.min(100, Number(digits(v)) || 0));
  const sim = simulation.data;
  const moves = sim ? Object.entries(sim.transitions).sort() : [];

  return (
    <>
      <PageHeader title="النقاط والفئات" description={`الإصدار ${active.version} سارٍ. كل تعديل إصدار جديد لا يسري حتى يعتمده موظف آخر.`}
        action={dirty && <Badge tone="warn">مسودة لم تُرسل</Badge>} />

      {pending && (
        <Alert tone="warn">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1"><strong>الإصدار {pending.version} ينتظر الاعتماد.</strong> اقترحه {pending.createdBy} · {formatDateTime(pending.createdAt)}.</div>
            {pending.createdBy === user?.username ? <span>اقترحتَه أنت: يعتمده غيرك.</span>
              : (user?.role === 'ADMIN' || user?.role === 'BENEFICIARY_SUPERVISOR') && (
                <>
                  <Button variant="danger" onClick={() => setDeciding(false)}>رفض</Button>
                  <Button onClick={() => setDeciding(true)}>اعتماد الإصدار {pending.version}</Button>
                </>
              )}
          </div>
        </Alert>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[2_1_30rem] flex-col gap-5">
          <Card className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">المعايير وأوزانها</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] border-collapse text-sm">
                <thead><tr className="text-muted">{['المعيار', 'الساري', 'الجديد'].map((h) => <th key={h} scope="col" className="border-b border-line p-2 text-start font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {FIELDS.map((f) => {
                    const old = active.criteria[f.key][f.field];
                    const now = criteria[f.key][f.field];
                    return (
                      <tr key={f.key + f.field} className="border-b border-line last:border-0">
                        <td className="p-2"><div className="font-semibold">{f.label}</div>{f.how && <div className="text-muted">{f.how}</div>}</td>
                        <td className="p-2 tabular-nums">{old}</td>
                        <td className="p-1">
                          <Input aria-label={`${f.label}: القيمة الجديدة`} inputMode="numeric" disabled={!isAdmin || !!pending}
                            className={`!w-20 tabular-nums ${now !== old ? 'border-2 !border-[#C8862A]' : ''}`} value={String(now)}
                            onChange={(e) => setCriteria({ ...criteria, [f.key]: { ...criteria[f.key], [f.field]: num(e.target.value) } })} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-muted">أقصى مجموع بالساري: <strong className="text-ink">{active.maxTotal}</strong>{sim && <>، وبالجديد: <strong className="text-ink">{sim.maxTotal}</strong></>}.</p>
          </Card>

          <Card className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">حدود الفئات</h2>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
              {(['a', 'b', 'c'] as const).map((k) => (
                <Field key={k} label={`الفئة ${CLASS_AR[k.toUpperCase()]}: من`}>
                  {(id) => <Input id={id} inputMode="numeric" disabled={!isAdmin || !!pending} className={thresholds[k] !== active.thresholds[k] ? 'border-2 !border-[#C8862A]' : ''}
                    value={String(thresholds[k])} onChange={(e) => setThresholds({ ...thresholds, [k]: num(e.target.value) })} />}
                </Field>
              ))}
            </div>
            <p className="text-muted">ما دون حدّ الفئة ج فهو الفئة د. خط الفقر: <strong className="text-ink">{formatNumber(povertyLineIqd)} دينار</strong>، ويُغيَّر من <Link to="/settings" className="font-semibold text-brand-strong underline">الإعدادات</Link>.</p>
          </Card>
        </div>

        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-5">
          <Card className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">العوائل بحسب الفئة</h2>
            {total === 0 && <p className="text-muted">لا عوائل معتمدة بعد.</p>}
            <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_3.5rem] items-center gap-x-3 gap-y-3">
              {[...ORDER].map((c) => (
                <div key={c} className="contents">
                  <span className="font-bold">{CLASS_AR[c]}</span>
                  <div aria-hidden="true" className="h-3.5 rounded bg-line"><div className="h-3.5 rounded bg-brand" style={{ width: `${total ? (classes[c] / total) * 100 : 0}%` }} /></div>
                  <span className="text-end tabular-nums">{formatNumber(classes[c])}</span>
                </div>
              ))}
            </div>
          </Card>

          {isAdmin && !pending && (
            <Card className={`flex flex-col gap-3 ${dirty ? '!border-2 !border-brand' : ''}`}>
              <h2 className="text-lg font-bold">أثر التعديل قبل اعتماده</h2>
              {!dirty && <p className="text-muted">غيّر وزناً أو حدّاً فيظهر هنا كم عائلة تنتقل من فئتها.</p>}
              {dirty && simulation.isPending && <Skeleton className="h-24 w-full" />}
              {dirty && simulation.error && <Alert>{simulation.error.message}</Alert>}
              {dirty && sim && (
                <>
                  <p>من {formatNumber(sim.families)} عائلة معتمدة، <strong>{formatNumber(sim.changed)}</strong> تتغير فئتها{sim.changed === 0 ? '.' : ':'}</p>
                  <ul className="flex flex-col gap-2">
                    {moves.map(([key, n]) => {
                      const [from, to] = key.split('>');
                      const up = ORDER.indexOf(to) < ORDER.indexOf(from);
                      return <li key={key} className="flex justify-between gap-3"><span>{up ? 'ترتفع' : 'تنزل'} من {CLASS_AR[from]} إلى {CLASS_AR[to]}</span><strong>{formatNumber(n)}</strong></li>;
                    })}
                  </ul>
                  {sim.affected.length > 0 && (
                    <details>
                      <summary className="min-h-11 cursor-pointer font-semibold text-brand-strong">اعرض العوائل المتأثرة{sim.changed > sim.affected.length ? ` (أول ${sim.affected.length})` : ''}</summary>
                      <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
                        {sim.affected.map((a) => (
                          <li key={a.familyId} className="flex justify-between gap-3">
                            <Link to={`/families/${a.familyId}`} className="font-semibold text-brand-strong">{a.familyNo} · {a.headName}</Link>
                            <span className="flex-none">{CLASS_AR[a.from]} {a.oldPoints} ← {CLASS_AR[a.to]} {a.newPoints}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="flex flex-wrap gap-2.5 border-t border-line pt-3">
                    <Button variant="secondary" className="flex-1" onClick={() => setCriteria(null)}>تراجع عن المسودة</Button>
                    <Button className="flex-1" onClick={() => { setSeen(false); setConfirming(true); }}>اطلب اعتماد الإصدار {history[0].version + 1}</Button>
                  </div>
                </>
              )}
            </Card>
          )}

          <Card className="flex flex-col gap-2.5">
            <h2 className="text-lg font-bold">الإصدارات</h2>
            {history.map((v) => (
              <div key={v.version} className="flex flex-col gap-0.5 border-b border-line pb-2 last:border-0">
                <div className="flex items-center justify-between gap-3"><strong>الإصدار {v.version}</strong><Badge tone={STATUS[v.status][1]}>{STATUS[v.status][0]}</Badge></div>
                <span className="text-sm text-muted">{v.note ?? ''}{v.createdBy ? ` اقترحه ${v.createdBy}` : ''}{v.decidedBy ? `، ${v.status === 'REJECTED' ? 'رفضه' : 'اعتمده'} ${v.decidedBy}` : ''}{v.decisionNote ? ` (${v.decisionNote})` : ''}</span>
              </div>
            ))}
          </Card>
        </div>
      </div>

      <Dialog open={confirming} title="تغيير معادلة النقاط" onClose={() => { propose.reset(); setConfirming(false); }}>
        {sim && <p>الإصدار الجديد ينقل <strong>{formatNumber(sim.changed)}</strong> عائلة من فئتها، ويُعاد حساب {formatNumber(sim.families)} عائلة عند اعتماده.</p>}
        {propose.error && <Alert>{propose.error.message}</Alert>}
        <label className="flex min-h-11 items-start gap-2.5"><input type="checkbox" className="mt-1 size-5 accent-brand" checked={seen} onChange={(e) => setSeen(e.target.checked)} /><span>اطّلعتُ على أثر التعديل وعلى العوائل المتأثرة</span></label>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setConfirming(false)}>إلغاء</Button>
          <Button disabled={!seen || propose.isPending} onClick={() => propose.mutate()}>اطلب اعتماد الإصدار</Button>
        </div>
      </Dialog>
      <ReasonDialog open={deciding !== null} danger={deciding === false} required={deciding === false}
        title={deciding ? `اعتماد الإصدار ${pending?.version}` : `رفض الإصدار ${pending?.version}`} confirmLabel={deciding ? 'اعتماد الإصدار' : 'رفض الإصدار'}
        pending={decide.isPending} error={decide.error?.message} onClose={() => { decide.reset(); setDeciding(null); }} onConfirm={(note) => decide.mutate(note)}>
        <p>{deciding ? 'يصير هذا الإصدار سارياً، ويُعاد حساب نقاط العوائل المعتمدة كلها فوراً.' : 'يبقى الإصدار الساري كما هو.'}</p>
      </ReasonDialog>
    </>
  );
}
