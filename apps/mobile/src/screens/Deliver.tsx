import { useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { compress } from '../lib/image';
import { REASON_TEXT, checkOffline, checkOfflineCode, type Reason } from '../lib/offline';
import { app, getState, useApp } from '../lib/store';
import { Button, Field, Notice, Screen, formatTime } from '../ui';
import { OnlineChip } from './Home';
import { Scanner } from './Scanner';

type Locate = { token: string } | { campaignId: string; familyNo: string; code: string };
interface Receiver { kind: 'HEAD' | 'PROXY'; name: string; proxyId?: string }
interface Subject { via: 'ONLINE' | 'OFFLINE'; locate: Locate; entitlementId: string; familyNo: string; headName: string; quantity: number; receivers: Receiver[]; note?: string; photoUrl?: string | null }
type Step =
  | { at: 'scan' }
  | { at: 'checking' }
  | { at: 'receiver'; subject: Subject; opId: string; busy?: boolean; error?: string; retry?: Receiver }
  | { at: 'refused'; title: string; advice: string; detail?: string }
  | { at: 'done'; opId: string; name: string; familyNo: string; quantity: number; offline: boolean; photo: boolean };

const CODES = new Set<string>(Object.keys(REASON_TEXT));
const ASCII = (v: string) => v.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

export function Deliver({ onBack }: { onBack: () => void }) {
  const s = useApp();
  const [step, setStep] = useState<Step>({ at: 'scan' });
  const [manual, setManual] = useState(false);
  const [familyNo, setFamilyNo] = useState('');
  const [code, setCode] = useState('');
  const photoInput = useRef<HTMLInputElement>(null);
  const station = s.station!;
  const manifest = s.manifest!;
  const deviceId = s.meta!.deviceId;

  const refuse = (reason: Reason, detail?: string) => setStep({ at: 'refused', ...REASON_TEXT[reason], detail });
  const localIds = () => new Set(getState().deliveries.filter((d) => d.sync !== 'UNKNOWN').map((d) => d.entitlementId));

  async function resolve(locate: Locate) {
    if (step.at === 'checking') return;
    setStep({ at: 'checking' });
    const opId = crypto.randomUUID();
    if (getState().online && getState().token) {
      try {
        const r = await api<{ entitlementId: string; familyNo: string; headName: string; quantity: number; atAssignedPoint: boolean; assignedPoint: string; receivers: Receiver[]; headPhotoUrl: string | null }>(
          '/deliveries/check', { token: getState().token, timeoutMs: 6000, body: { pointId: station.pointId, deviceId, locate } });
        setStep({ at: 'receiver', opId, subject: { via: 'ONLINE', locate, entitlementId: r.entitlementId, familyNo: r.familyNo, headName: r.headName, quantity: r.quantity, receivers: r.receivers, photoUrl: r.headPhotoUrl,
          note: r.atAssignedPoint ? undefined : `نقطتها المعيَّنة: ${r.assignedPoint}. يجوز التسليم هنا والجهاز متصل.` } });
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.code && CODES.has(err.code)) {
          const d = err.details;
          return refuse(err.code as Reason, d?.deliveredAt ? `استلمه ${d.receiverName ?? '—'} الساعة ${formatTime(d.deliveredAt)}${d.point ? ` في ${d.point}` : ''}.` : undefined);
        }
        if (err instanceof ApiError && err.status === 409) return setStep({ at: 'refused', title: err.message.replace(/^لا تسلّم: /, ''), advice: 'أحِله إلى المشرف.' });
        if (err instanceof ApiError && err.offline) app.setOnline(false);
        // انقطاع أو جلسة منتهية: يُحكم بما على الجهاز.
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const res = 'token' in locate ? checkOffline(locate.token, manifest, localIds(), now) : await checkOfflineCode(locate.familyNo, locate.code, manifest, localIds(), now);
    if (!res.ok) {
      const prior = res.reason !== 'ALREADY_DELIVERED' ? undefined
        : getState().deliveries.find((d) => ('token' in locate ? checkSame(locate.token, d.entitlementId) : d.familyNo === locate.familyNo));
      return refuse(res.reason, prior ? `سلّمتَه أنت إلى ${prior.receiverName} الساعة ${formatTime(prior.deliveredAt)}.` : undefined);
    }
    const e = res.entry;
    setStep({ at: 'receiver', opId, subject: { via: 'OFFLINE', locate, entitlementId: e.id, familyNo: e.familyNo, headName: e.headName, quantity: e.quantity, receivers: e.receivers } });
  }

  async function confirm(subject: Subject, opId: string, receiver: Receiver) {
    setStep({ at: 'receiver', subject, opId, busy: true });
    const base = { clientOpId: opId, entitlementId: subject.entitlementId, familyNo: subject.familyNo, headName: subject.headName, quantity: subject.quantity, unit: station.unit,
      deliveredAt: new Date().toISOString(), receiver: receiver.kind, receiverName: receiver.name, photo: 'NONE' as const };
    const finish = (offline: boolean) => setStep({ at: 'done', opId, name: receiver.name, familyNo: subject.familyNo, quantity: subject.quantity, offline, photo: false });
    if (subject.via === 'OFFLINE') {
      await app.recordDelivery({ ...base, mode: 'OFFLINE', sync: 'PENDING' });
      return finish(true);
    }
    try {
      const r = await api<{ deliveredAt: string }>('/deliveries/redeem', {
        token: getState().token, timeoutMs: 10_000,
        body: { pointId: station.pointId, deviceId, locate: subject.locate, clientOpId: opId, receiver: receiver.kind === 'PROXY' ? { kind: 'PROXY', proxyId: receiver.proxyId } : { kind: 'HEAD' } },
      });
      await app.recordDelivery({ ...base, deliveredAt: r.deliveredAt, mode: 'ONLINE', sync: 'SYNCED' });
      finish(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code && CODES.has(err.code)) return refuse(err.code as Reason);
      if (!(err instanceof ApiError) || !(err.offline || err.status === 401)) return setStep({ at: 'receiver', subject, opId, error: err instanceof Error ? err.message : 'تعذّر التسليم' });
      if (err.offline) app.setOnline(false);
      // انقطع الاتصال والطلب في الطريق: لا يُعرف هل بلغ الخادم. إن كانت من حصة هذا الجهاز سُجّلت عليه
      // بالمعرّف نفسه، فإن كان الخادم قد قبلها عدّتها المزامنة واحدة. وإلا فلا يُسلَّم حتى يُعاد الطلب.
      const mine = manifest.entries.some((e) => e.id === subject.entitlementId && e.status === 'PENDING') && !localIds().has(subject.entitlementId);
      if (mine) {
        await app.recordDelivery({ ...base, mode: 'OFFLINE', sync: 'PENDING' });
        return finish(true);
      }
      setStep({ at: 'receiver', subject, opId, retry: receiver, error: 'انقطع الاتصال قبل تأكيد الخادم، وهذه العائلة ليست من حصة جهازك. لا تسلّم حتى ينجح الطلب.' });
    }
  }

  async function onPhoto(file: File | undefined) {
    if (!file || step.at !== 'done') return;
    try {
      await app.attachPhoto(step.opId, await compress(file, 1280));
      setStep({ ...step, photo: true });
      if (getState().online) void app.sync();
    } catch { /* الصورة اختيارية: فشلها لا يُبطل التسليم */ }
  }

  const title = `${station.pointName} · شبّاك ${station.lane}`;
  if (step.at === 'refused') {
    return (
      <Screen title={title} status={<OnlineChip />}>
        <div role="alert" className="flex flex-1 flex-col justify-center gap-4 rounded-2xl bg-danger px-5 py-8 text-center text-white">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="mx-auto size-20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /></svg>
          <h2 className="text-3xl font-bold">لا تسلّم</h2>
          <p className="text-xl font-semibold">{step.title}</p>
          {step.detail && <p className="text-lg">{step.detail}</p>}
          <p>{step.advice}</p>
        </div>
        <Button onClick={() => setStep({ at: 'scan' })}>التالي</Button>
      </Screen>
    );
  }
  if (step.at === 'done') {
    return (
      <Screen title={title} status={<OnlineChip />}>
        <div role="status" className="flex flex-1 flex-col justify-center gap-3 rounded-2xl bg-brand px-5 py-8 text-center text-white">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="mx-auto size-20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.8 2.8L16 9.5" /></svg>
          <h2 className="text-3xl font-bold">سُجّل التسليم</h2>
          <p className="text-xl">{step.name}</p>
          <p className="text-lg">العائلة {step.familyNo} · {step.quantity} {station.unit}</p>
          <p className="text-sm opacity-90">{step.offline ? 'حُفظ على الجهاز، ويُرفع حين يتصل.' : 'وصل الخادم.'}</p>
        </div>
        <input ref={photoInput} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="صورة التسليم" onChange={(e) => void onPhoto(e.target.files?.[0])} />
        {step.photo ? <Notice tone="ok">حُفظت الصورة.</Notice> : <Button variant="secondary" onClick={() => photoInput.current?.click()}>صوّر التسليم (اختياري)</Button>}
        <Button onClick={() => { setFamilyNo(''); setCode(''); setStep({ at: 'scan' }); }}>التالي</Button>
      </Screen>
    );
  }
  if (step.at === 'receiver') {
    const { subject, opId } = step;
    return (
      <Screen title={title} status={<OnlineChip />} onBack={() => setStep({ at: 'scan' })}>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm text-muted">العائلة {subject.familyNo}</p>
          <p className="text-xl font-bold">{subject.headName}</p>
          <p className="text-lg">تستلم: <strong>{subject.quantity} {station.unit}</strong></p>
          {subject.via === 'OFFLINE' && <p className="mt-1 text-sm font-semibold text-warn-ink">الجهاز منقطع: حُكم بالبيان المحمَّل.</p>}
        </div>
        {subject.photoUrl && (
          <figure className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
            <img src={subject.photoUrl} alt={`صورة ${subject.headName}`} className="size-24 flex-none rounded-xl object-cover" />
            <figcaption className="text-sm text-muted">صورة رب الأسرة من ملفه. طابق بها وجه الحاضر.</figcaption>
          </figure>
        )}
        {subject.note && <Notice tone="warn">{subject.note}</Notice>}
        {step.error && <Notice>{step.error}</Notice>}
        {step.retry ? <Button disabled={step.busy} onClick={() => void confirm(subject, opId, step.retry!)}>أعد المحاولة</Button> : (
          <>
            <h2 className="text-lg font-bold">من الحاضر؟</h2>
            <div className="flex flex-col gap-3">
              {subject.receivers.map((r, i) => (
                <Button key={i} variant={i === 0 ? 'primary' : 'secondary'} disabled={step.busy} className="h-auto min-h-16 flex-col !items-start py-2 text-start" onClick={() => void confirm(subject, opId, r)}>
                  <span>{r.name}</span><span className="text-sm font-normal opacity-90">{r.kind === 'HEAD' ? 'رب الأسرة' : 'وكيل مسجَّل'}</span>
                </Button>
              ))}
            </div>
          </>
        )}
        <Button variant="danger" disabled={step.busy} className="mt-auto" onClick={() => setStep({ at: 'scan' })}>ليس أحدهم: لا تسلّم</Button>
      </Screen>
    );
  }
  return (
    <Screen title={title} status={<OnlineChip />} onBack={onBack}>
      {!s.online && <Notice tone="warn">الجهاز منقطع: لا يُقبل إلا من كان في حصة هذا الشبّاك ({manifest.entries.length} عائلة).</Notice>}
      {step.at === 'checking' ? <div role="status" className="grid aspect-[4/3] place-items-center rounded-2xl bg-surface text-lg font-semibold">يُتحقَّق من الرمز…</div>
        : manual ? null : <Scanner paused={false} onResult={(text) => void resolve({ token: text })} />}
      {manual ? (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void resolve(code.trim().startsWith('E1.') ? { token: code.trim() } : { campaignId: station.campaignId, familyNo: ASCII(familyNo).trim(), code: ASCII(code).trim() }); }}>
          <Field label="رقم العائلة" inputMode="numeric" dir="ltr" value={familyNo} onChange={(e) => setFamilyNo(e.target.value)} />
          <Field label="الرمز الرقمي" hint="الأرقام الثمانية في رسالة الدعوة أو على البطاقة." inputMode="numeric" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} required />
          <Button type="submit" disabled={step.at === 'checking' || !code.trim()}>تحقّق</Button>
          <Button variant="secondary" onClick={() => setManual(false)}>امسح بالكاميرا</Button>
        </form>
      ) : <Button variant="secondary" onClick={() => setManual(true)}>اكتب رقم العائلة ورمزها</Button>}
    </Screen>
  );
}

/** هل هذا الرمز لهذا الاستحقاق؟ يُقرأ من حمولته دون تحقق من التوقيع (للعرض فقط). */
function checkSame(token: string, entitlementId: string): boolean {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).e === entitlementId;
  } catch {
    return false;
  }
}
