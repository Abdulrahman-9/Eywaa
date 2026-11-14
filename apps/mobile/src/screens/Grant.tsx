import { useState } from 'react';
import { normalizeName } from '../lib/names';
import { app, getState, useApp, type Grant } from '../lib/store';
import { Button, Field, Notice, Screen, SelectField, formatTime } from '../ui';

const ASCII = (v: string) => v.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

/**
 * الصرف لغير المسجَّلين بتخويل المدير. الاسم وحده لازم، ليبقى العمل سلساً في الزحام.
 * السقف والمدة يُحرسان على الهاتف ولو انقطع، ثم يحكم الخادم عند الرفع.
 */
export function GrantScreen({ onBack }: { onBack: () => void }) {
  const s = useApp();
  const live = s.grants.filter((g) => new Date(g.expiresAt).getTime() > Date.now());
  const [grantId, setGrantId] = useState(live[0]?.id ?? '');
  const [form, setForm] = useState({ headName: '', phone: '', mahalla: '', members: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const grant: Grant | undefined = live.find((g) => g.id === grantId);
  const pendingOf = (id: string) => s.cases.filter((c) => c.grantId === id && c.sync === 'PENDING').length;
  const left = grant ? grant.maxCases - grant.used - pendingOf(grant.id) : 0;

  async function save() {
    if (!grant) return;
    setError(''); setDone('');
    const name = form.headName.trim();
    if (name.split(/\s+/).length < 2) return setError('اكتب الاسم ثنائياً على الأقل. كلما اكتمل الاسم سهل استكمال تسجيله.');
    if (new Date(grant.expiresAt).getTime() <= Date.now()) return setError('انتهت مدة التخويل.');
    if (left <= 0) return setError(`استُنفد التخويل: ${grant.maxCases} حالة.`);
    const norm = normalizeName(name);
    const phone = ASCII(form.phone).replace(/\D/g, '');
    // الاسم نفسه أو الهاتف نفسه على هذا الهاتف: صُرف له. والخادم يفحص عند غيرك.
    const same = getState().cases.find((c) => c.sync !== 'REJECTED' && getState().grants.find((g) => g.id === c.grantId)?.campaignId === grant.campaignId && (normalizeName(c.headName) === norm || (!!phone && c.phone === phone)));
    if (same) return setError(`صرفتَ لـ«${same.headName}» الساعة ${formatTime(same.deliveredAt)}. لا يُصرف له مرتين.`);
    await app.addCase({
      clientOpId: crypto.randomUUID(), grantId: grant.id, headName: name, phone: phone || undefined, mahalla: form.mahalla.trim() || undefined,
      membersCount: Number(ASCII(form.members)) || undefined, quantity: grant.perCase, unit: grant.unit, deliveredAt: new Date().toISOString(), sync: 'PENDING',
    });
    setDone(`سُجّل: ${name} · ${grant.perCase} ${grant.unit}`);
    setForm({ headName: '', phone: '', mahalla: '', members: '' });
    if (getState().online) void app.sync();
  }

  return (
    <Screen title="صرف بتخويل" onBack={onBack}>
      {live.length === 0 && <Notice tone="warn">لا تخويل سارٍ الآن. لا يُصرف لغير المسجَّلين إلا بإذن المدير.</Notice>}
      {grant && (
        <>
          {live.length > 1 && <SelectField label="التخويل" value={grantId} onChange={(e) => setGrantId(e.target.value)}>{live.map((g) => <option key={g.id} value={g.id}>{g.campaignName}</option>)}</SelectField>}
          <div className="rounded-2xl border border-line bg-surface p-4">
            <p className="font-bold">{grant.campaignName}</p>
            <p>بقي <strong data-testid="grant-left">{Math.max(0, left)}</strong> من {grant.maxCases} · {grant.perCase} {grant.unit} للحالة · حتى {formatTime(grant.expiresAt)}</p>
            <p className="text-sm text-muted">{grant.reason}</p>
          </div>
          {error && <Notice>{error}</Notice>}
          {done && <Notice tone="ok">{done}</Notice>}
          <Field label="اسم المستلم" hint="الاسم وحده لازم. اكتبه كاملاً ما أمكن." value={form.headName} onChange={(e) => setForm({ ...form, headName: e.target.value })} />
          <Field label="الهاتف (إن تيسّر)" type="tel" inputMode="tel" dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="المحلة (إن تيسّرت)" value={form.mahalla} onChange={(e) => setForm({ ...form, mahalla: e.target.value })} />
            <Field label="عدد الأفراد" inputMode="numeric" dir="ltr" value={form.members} onChange={(e) => setForm({ ...form, members: e.target.value })} />
          </div>
          <Button disabled={!form.headName.trim() || left <= 0} onClick={() => void save()}>اصرف وسجّل</Button>
        </>
      )}
      {s.cases.length > 0 && (
        <>
          <h2 className="text-lg font-bold">ما صرفتَه بتخويل ({s.cases.filter((c) => c.sync !== 'REJECTED').length})</h2>
          <ul className="flex flex-col gap-2">
            {[...s.cases].reverse().map((c) => (
              <li key={c.clientOpId} className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3">
                <div className="flex items-baseline justify-between gap-2"><strong>{c.headName}</strong><span className="text-sm tabular-nums text-muted">{formatTime(c.deliveredAt)}</span></div>
                {c.sync === 'PENDING' && <span className="font-semibold text-warn-ink">ينتظر الرفع</span>}
                {c.sync === 'SYNCED' && <span className="font-semibold text-brand-strong">وصل الخادم · {c.quantity} {c.unit}</span>}
                {c.sync === 'SYNCED' && c.warnings?.map((w) => <span key={w} className="text-sm text-warn-ink">{w}</span>)}
                {c.sync === 'REJECTED' && (
                  <>
                    <span className="font-semibold text-danger">ردّه الخادم: {c.error}</span>
                    <span className="text-sm">ما صرفتَه له محسوب عليك؛ يسألك عنه مدير التوزيع.</span>
                    <Button variant="secondary" className="min-h-11 self-start text-base" onClick={() => void app.dropCase(c.clientOpId)}>أزله من الجهاز</Button>
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
