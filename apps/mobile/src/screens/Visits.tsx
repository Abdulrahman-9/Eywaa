import { useState } from 'react';
import { app, getState, useApp, type Visit } from '../lib/store';
import { Button, Notice, Screen, SelectField, formatTime } from '../ui';

const SOURCE = { FAMILY: 'بطلب العائلة', STAFF: 'من الإدارة' } as const;

/** زيارات إعادة التقييم المطلوبة من هذا الموظف. تُسجَّل الزيارة على الجهاز ولو انقطع الاتصال. */
export function Visits({ onBack }: { onBack: () => void }) {
  const s = useApp();
  const [current, setCurrent] = useState<Visit | null>(null);
  const [findings, setFindings] = useState('');
  const [outcome, setOutcome] = useState<'NO_CHANGE' | 'CHANGED'>('NO_CHANGE');
  const [busy, setBusy] = useState(false);
  const todo = s.visits.filter((v) => !s.visitReports.some((r) => r.reassessmentId === v.id));

  async function save() {
    if (!current) return;
    setBusy(true);
    await app.addVisitReport({
      clientOpId: crypto.randomUUID(), reassessmentId: current.id, familyNo: current.familyNo, headName: current.headName,
      findings: findings.trim(), outcome, visitedAt: new Date().toISOString(), sync: 'PENDING',
    });
    setBusy(false);
    setCurrent(null);
    if (getState().online) void app.sync();
  }

  if (current) {
    return (
      <Screen title="تسجيل الزيارة" onBack={() => setCurrent(null)}>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm text-muted">العائلة {current.familyNo}</p>
          <p className="text-xl font-bold">{current.headName}</p>
          <p><span className="text-muted">سبب الطلب: </span>{current.reason}</p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="visit-findings" className="font-semibold">ما وجدتَه في الزيارة</label>
          <textarea id="visit-findings" rows={6} value={findings} onChange={(e) => setFindings(e.target.value)} className="w-full rounded-xl border border-line-strong bg-surface px-4 py-3 text-lg" />
          <span className="text-sm text-muted">اكتب ما رأيتَه بعينك اليوم. شهادتك تُحفظ باسمك، ويعتمدها موظف غيرك.</span>
        </div>
        <SelectField label="النتيجة" value={outcome} onChange={(e) => setOutcome(e.target.value as 'NO_CHANGE' | 'CHANGED')}>
          <option value="NO_CHANGE">لم يتغيّر من حالها شيء</option>
          <option value="CHANGED">تغيّرت حالها</option>
        </SelectField>
        {outcome === 'CHANGED' && <Notice tone="warn">الزيارة لا تغيّر بيانات العائلة. اذكر هنا ما تغيّر بدقة (الدخل، الأفراد، السكن)، ثم قدّم طلبات التعديل من لوحة الإدارة.</Notice>}
        <Button className="mt-auto" disabled={findings.trim().length < 10 || busy} onClick={() => void save()}>احفظ على الجهاز</Button>
      </Screen>
    );
  }

  return (
    <Screen title="زيارات إعادة التقييم" onBack={onBack}>
      {todo.length === 0 && <p className="py-6 text-center text-muted">لا زيارات مطلوبة منك الآن. زامن لتتجدد القائمة.</p>}
      <ul className="flex flex-col gap-3">
        {todo.map((v) => (
          <li key={v.id} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
            <div><p className="text-lg font-bold">{v.headName}</p><p className="text-sm text-muted">العائلة {v.familyNo} · {SOURCE[v.source]}</p></div>
            <p>{v.reason}</p>
            {(v.mahalla || v.landmark) && <p className="text-muted">{[v.mahalla, v.landmark].filter(Boolean).join('، ')}</p>}
            <div className="grid grid-cols-2 gap-3">
              {v.phone ? <a href={`tel:${v.phone}`} className="inline-flex min-h-14 items-center justify-center rounded-xl border border-line-strong text-lg font-semibold" dir="ltr">{v.phone}</a> : <span className="grid min-h-14 place-items-center text-muted">بلا هاتف</span>}
              <Button onClick={() => { setFindings(''); setOutcome('NO_CHANGE'); setCurrent(v); }}>سجّل الزيارة</Button>
            </div>
          </li>
        ))}
      </ul>
      {s.visitReports.length > 0 && (
        <>
          <h2 className="text-lg font-bold">ما سجّلتَه</h2>
          <ul className="flex flex-col gap-2">
            {[...s.visitReports].reverse().map((r) => (
              <li key={r.clientOpId} className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3">
                <div className="flex items-baseline justify-between gap-2"><strong>{r.headName ?? r.familyNo}</strong><span className="text-sm tabular-nums text-muted">{formatTime(r.visitedAt)}</span></div>
                {r.sync === 'PENDING' && <span className="font-semibold text-warn-ink">تنتظر الرفع</span>}
                {r.sync === 'SYNCED' && <span className="font-semibold text-brand-strong">وصلت الخادم، وتنتظر الاعتماد</span>}
                {r.sync === 'REJECTED' && (
                  <>
                    <span className="font-semibold text-danger">ردّها الخادم: {r.error}</span>
                    <Button variant="secondary" className="min-h-11 self-start text-base" onClick={() => void app.dropVisitReport(r.clientOpId)}>أزلها من الجهاز</Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Screen>
  );
}
