import { useState } from 'react';
import { app, getState, inspectionsTodo, useApp, type InspectionTask, type Recommendation } from '../lib/store';
import { Button, Field, Notice, Screen, TextArea, formatAgo, formatDayTime } from '../ui';

type Result = 'MATCH' | 'MISMATCH' | 'UNCHECKED';
type Contact = 'FAMILY' | 'OTHERS' | 'NONE';
const CONTACTS: [Contact, string][] = [['FAMILY', 'قابلتُ العائلة في دارها'], ['OTHERS', 'لم أجدها، وسألتُ من يعرفها'], ['NONE', 'لم أجد العائلة ولا من يعرفها']];
const RECS: [Recommendation, string, string][] = [
  ['CONFIRM', 'الحال كما سُجّل', 'لا تغيير'],
  ['RAISE', 'حالهم أشدّ مما سُجّل', 'أوصي برفع نقاطهم'],
  ['LOWER', 'حالهم أيسر مما سُجّل', 'أوصي بخفض نقاطهم'],
  ['REMOVE', 'لا تستحق التسجيل', 'أطلب شطب العائلة'],
  ['UNABLE', 'تعذّر الكشف', 'لم أستطع أن أرى حالهم'],
];
const REC_AR: Record<string, string> = { CONFIRM: 'مطابقة', RAISE: 'أوصيتَ بالرفع', LOWER: 'أوصيتَ بالخفض', REMOVE: 'طلبتَ الشطب', UNABLE: 'تعذّر الكشف' };
const REASON_LABEL: Record<Recommendation, string> = {
  CONFIRM: '', RAISE: 'ما الذي رأيتَه مما لم يُسجَّل؟', LOWER: 'ما الذي رأيتَه مما يدل على اليسر؟', REMOVE: 'لماذا تُشطب؟', UNABLE: 'لماذا تعذّر الكشف؟',
};
const SYNC = { PENDING: ['ينتظر الرفع', 'text-warn-ink'], SYNCED: ['وصل الخادم', 'text-brand-strong'], REJECTED: ['ردّه الخادم', 'text-danger'] } as const;

/** ما آل إليه كشف رفعه الكاشف، بعبارة واحدة. */
function outcome(r: { status: string; effect: string | null; points: number | null; decisionNote: string | null }): [string, string] {
  if (r.status === 'APPROVED') return [r.effect === 'RAISED' ? `اعتُمد: رُفعت نقاطها ${r.points}` : r.effect === 'LOWERED' ? `اعتُمد: خُفضت نقاطها ${r.points}` : r.effect === 'REMOVED' ? 'اعتُمد: شُطبت العائلة' : 'اعتُمد بلا تغيير', 'text-brand-strong'];
  if (r.status === 'REJECTED') return [`لم يُعتمد${r.decisionNote ? `: ${r.decisionNote}` : ''}`, 'text-danger'];
  if (r.status === 'CANCELLED') return ['أُلغي التكليف', 'text-muted'];
  return ['ينتظر اعتماد المدير', 'text-warn-ink'];
}

/**
 * الكشف الميداني. الكاشف يطابق ما في السجل بما يرى، ويكتب ملاحظاته وتوصيته؛ والقرار للمدير.
 * يعمل والهاتف منقطع: صورة العائلة حُمّلت عند المزامنة، والتقرير يُرفع حين يعود الاتصال.
 */
export function Inspect({ onBack }: { onBack: () => void }) {
  const s = useApp();
  const [task, setTask] = useState<InspectionTask | null>(null);
  const [done, setDone] = useState('');
  const todo = inspectionsTodo(s);
  if (task) return <Form task={task} onBack={() => setTask(null)} onSaved={(text) => { setDone(text); setTask(null); }} />;
  return (
    <Screen title="الكشف الميداني" onBack={onBack}>
      {done && <Notice tone="ok">{done}</Notice>}
      {todo.length === 0 && <Notice tone="warn">لا كشف مطلوب منك الآن. زامن لتتجدد القائمة.</Notice>}
      <ul className="flex flex-col gap-3">
        {todo.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => { setDone(''); setTask(t); }} className={`flex w-full flex-col gap-1 rounded-2xl border bg-surface p-4 text-start active:bg-ground ${t.late ? 'border-2 border-[#C8862A]' : 'border-line'}`}>
              <span className="flex items-baseline justify-between gap-2"><strong className="text-lg">{t.family.headName ?? '—'}</strong><span className="text-sm tabular-nums text-muted">العائلة {t.family.familyNo}</span></span>
              <span className="text-muted">{t.family.address || 'بلا عنوان مسجَّل'}</span>
              {t.note && <span className="font-semibold text-info-ink">المطلوب: {t.note}</span>}
              {t.partner && <span className="text-sm text-muted">يكشفها أيضاً {t.partner}. كلٌّ منكما يرفع ما رآه.</span>}
              <span className={`text-sm ${t.late ? 'font-semibold text-warn-ink' : 'text-muted'}`}>كُلّفتَ بها {formatAgo(t.requestedAt)}{t.late ? ': تأخّرت' : ''}</span>
            </button>
          </li>
        ))}
      </ul>
      {(s.inspectionOps.length > 0 || s.inspectionResults.length > 0) && (
        <>
          <h2 className="text-lg font-bold">ما كشفتَه</h2>
          <ul className="flex flex-col gap-2">
            {[...s.inspectionOps].reverse().map((o) => (
              <li key={o.clientOpId} className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3">
                <div className="flex items-baseline justify-between gap-2"><strong>{o.headName ?? `العائلة ${o.familyNo}`}</strong><span className={`font-semibold ${SYNC[o.sync][1]}`}>{SYNC[o.sync][0]}</span></div>
                <span className="text-sm text-muted">العائلة {o.familyNo} · {REC_AR[o.recommendation]} · {formatDayTime(o.visitedAt)}</span>
                {o.sync === 'REJECTED' && <><span className="text-sm text-danger">{o.error}</span><Button variant="secondary" className="min-h-11 self-start text-base" onClick={() => void app.dropOp('inspectionOps', o.clientOpId)}>أزله من الجهاز</Button></>}
              </li>
            ))}
            {s.inspectionResults.map((r) => {
              const [text, tone] = outcome(r);
              return (
                <li key={r.id} className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3">
                  <div className="flex items-baseline justify-between gap-2"><strong>{r.headName ?? `العائلة ${r.familyNo}`}</strong><span className="text-sm tabular-nums text-muted">كشف {r.no}</span></div>
                  <span className="text-sm text-muted">العائلة {r.familyNo} · {REC_AR[r.recommendation]} · {formatDayTime(r.submittedAt)}</span>
                  <span className={`font-semibold ${tone}`}>{text}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Screen>
  );
}

function Form({ task, onBack, onSaved }: { task: InspectionTask; onBack: () => void; onSaved: (text: string) => void }) {
  const f = task.family;
  const [contact, setContact] = useState<Contact | null>(null);
  const [checks, setChecks] = useState<Record<string, { result: Result; found: string }>>({});
  const [notes, setNotes] = useState('');
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const get = (key: string) => checks[key] ?? { result: 'UNCHECKED' as Result, found: '' };
  const set = (key: string, patch: Partial<{ result: Result; found: string }>) => { setError(''); setChecks((c) => ({ ...c, [key]: { ...get(key), ...patch } })); };
  const verified = f.facts.filter((x) => get(x.key).result !== 'UNCHECKED').length;
  const mismatches = f.facts.filter((x) => get(x.key).result === 'MISMATCH').length;
  // من لم يجد أحداً لم يرَ شيئاً: لا يطابق ولا يوصي بنقاط.
  const blind = contact === 'NONE';
  const allowed = (r: Recommendation) => !blind || r === 'REMOVE' || r === 'UNABLE';

  async function save() {
    setError('');
    if (!contact) return setError('اختر من لقيتَ.');
    if (!rec) return setError('اختر توصيتك.');
    if (!allowed(rec)) return setError('لم تجد العائلة ولا من يعرفها: علّم أن الكشف تعذّر، أو اطلب شطبها بسببه.');
    const bad = f.facts.find((x) => get(x.key).result === 'MISMATCH' && get(x.key).found.trim().length < 2);
    if (!blind && bad) return setError(`اكتب ما وجدتَه في «${bad.label}».`);
    if (rec !== 'CONFIRM' && reason.trim().length < 3) return setError(`${REASON_LABEL[rec]} اكتبه.`);
    if ((rec === 'CONFIRM' || rec === 'RAISE' || rec === 'LOWER') && !verified) return setError('لم تطابق بنداً واحداً. طابق ما رأيتَ، أو علّم أن الكشف تعذّر.');
    await app.addInspection({
      clientOpId: crypto.randomUUID(), inspectionId: task.id, no: task.no, familyNo: f.familyNo, headName: f.headName, visitedAt: new Date().toISOString(), contact,
      checks: blind ? [] : f.facts.map((x) => ({ key: x.key, result: get(x.key).result, ...(get(x.key).result === 'MISMATCH' ? { found: get(x.key).found.trim() } : {}) })),
      notes: notes.trim() || undefined, recommendation: rec, reason: rec === 'CONFIRM' ? undefined : reason.trim(), sync: 'PENDING',
    });
    if (getState().online) void app.sync();
    onSaved(`سُجّل كشف العائلة ${f.familyNo}. يُرفع إلى المدير ليعتمده.`);
  }

  return (
    <Screen title={`كشف العائلة ${f.familyNo}`} onBack={onBack}>
      <section aria-label="العائلة" className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
        <p className="text-xl font-bold">{f.headName ?? '—'}</p>
        <p className="text-muted">{f.address || 'بلا عنوان مسجَّل'}</p>
        {f.phone && <a className="font-semibold text-brand-strong underline" dir="ltr" href={`tel:${f.phone}`}>{f.phone}</a>}
        {f.location && <a className="font-semibold text-brand-strong underline" href={`https://maps.google.com/?q=${f.location.lat},${f.location.lng}`} target="_blank" rel="noreferrer">موقع الدار على الخريطة</a>}
        {task.note && <Notice tone="warn">المطلوب التحقق منه: {task.note}</Notice>}
        <details className="rounded-xl bg-ground px-3 py-2">
          <summary className="cursor-pointer font-semibold">الأفراد المسجَّلون ({f.members.length})</summary>
          <ul className="flex flex-col gap-1 pt-2">
            {f.members.map((m, i) => <li key={i} className="text-sm"><strong>{m.name}</strong> · {m.relation}{m.age !== null ? ` · ${m.age} سنة` : ''}{[m.isOrphan && 'يتيم', m.disability, m.chronicIllness].filter(Boolean).map((x) => ` · ${x}`).join('')}</li>)}
          </ul>
        </details>
      </section>

      <section aria-label="من لقيت" className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">من لقيتَ؟</h2>
        {CONTACTS.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={contact === key} onClick={() => { setContact(key); if (key === 'NONE' && rec && rec !== 'REMOVE' && rec !== 'UNABLE') setRec(null); }}
            className={`min-h-14 rounded-xl border px-4 text-start text-lg font-semibold ${contact === key ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface'}`}>{label}</button>
        ))}
      </section>

      {!blind && (
        <section aria-label="المطابقة" className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-bold">طابق ما في السجل بما رأيتَ</h2>
            <span className="text-sm text-muted" data-testid="verified">{verified} من {f.facts.length}{mismatches ? ` · ${mismatches} غير مطابق` : ''}</span>
          </div>
          <Button variant="secondary" className="min-h-12 text-base" onClick={() => setChecks(Object.fromEntries(f.facts.map((x) => [x.key, { result: 'MATCH' as Result, found: '' }])))}>كل ما في السجل مطابق</Button>
          {f.facts.map((x) => {
            const c = get(x.key);
            return (
              <div key={x.key} role="group" aria-label={x.label} className={`flex flex-col gap-2 rounded-2xl border bg-surface p-3 ${c.result === 'MISMATCH' ? 'border-2 border-danger' : c.result === 'MATCH' ? 'border-brand' : 'border-line'}`}>
                <div><span className="text-sm text-muted">{x.label}</span><p className="text-lg font-semibold">{x.recorded}</p></div>
                <div className="grid grid-cols-3 gap-2">
                  {([['MATCH', 'مطابق'], ['MISMATCH', 'غير مطابق'], ['UNCHECKED', 'لم أتحقق']] as const).map(([r, label]) => (
                    <button key={r} type="button" aria-pressed={c.result === r} onClick={() => set(x.key, { result: r })}
                      className={`min-h-12 rounded-xl border px-1 font-semibold ${c.result === r ? (r === 'MATCH' ? 'border-brand bg-brand text-white' : r === 'MISMATCH' ? 'border-danger bg-danger text-white' : 'border-line-strong bg-ground') : 'border-line-strong bg-surface text-muted'}`}>{label}</button>
                  ))}
                </div>
                {c.result === 'MISMATCH' && <Field label={`ما وجدتَه في «${x.label}»`} value={c.found} onChange={(e) => set(x.key, { found: e.target.value })} />}
              </div>
            );
          })}
        </section>
      )}

      <TextArea label="ملاحظاتك" hint="ما رأيتَه من حال الدار والعائلة مما لا تحمله البنود" value={notes} onChange={(e) => setNotes(e.target.value)} />

      <section aria-label="التوصية" className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">توصيتك</h2>
        <p className="text-sm text-muted">أنت تشهد وتوصي، والقرار للمدير.</p>
        {RECS.map(([key, title, hint]) => (
          <button key={key} type="button" role="radio" aria-checked={rec === key} disabled={!allowed(key)} onClick={() => { setRec(key); setError(''); }}
            className={`flex min-h-14 flex-col justify-center rounded-xl border px-4 py-2 text-start disabled:opacity-40 ${rec === key ? (key === 'REMOVE' ? 'border-danger bg-danger text-white' : 'border-brand bg-brand text-white') : 'border-line-strong bg-surface'}`}>
            <span className="text-lg font-semibold">{title}</span><span className={`text-sm ${rec === key ? 'text-white/85' : 'text-muted'}`}>{hint}</span>
          </button>
        ))}
        {rec && rec !== 'CONFIRM' && <TextArea label={REASON_LABEL[rec]} value={reason} onChange={(e) => { setReason(e.target.value); setError(''); }} />}
      </section>

      {error && <Notice>{error}</Notice>}
      <Button onClick={() => void save()}>ارفع الكشف</Button>
    </Screen>
  );
}
