import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { app, useApp, type User } from '../lib/store';
import { Button, Field, Notice, Screen } from '../ui';

function Credentials({ fixedUser, submitLabel, onDone }: { fixedUser?: string; submitLabel: string; onDone: (username: string, password: string, code?: string) => Promise<void> }) {
  const [username, setUsername] = useState(fixedUser ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await onDone(username.trim(), password, needCode ? code.trim() : undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOTP_REQUIRED') setNeedCode(true);
      else setError(err instanceof ApiError && err.offline ? 'الدخول يحتاج اتصالاً بالشبكة. اتصل ثم أعد المحاولة.' : err instanceof Error ? err.message : 'تعذّر الدخول');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error && <Notice>{error}</Notice>}
      <Field label="اسم المستخدم" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoCorrect="off" dir="ltr" readOnly={!!fixedUser} required />
      <Field label="كلمة المرور" type="password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" required />
      {needCode && <Field label="رمز التحقق من تطبيق المصادقة" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" dir="ltr" autoFocus required />}
      <Button type="submit" disabled={busy}>{busy ? 'جارٍ الدخول…' : submitLabel}</Button>
    </form>
  );
}

function PinPad({ label, hint, onSubmit, busy, error }: { label: string; hint?: string; onSubmit: (pin: string) => void; busy?: boolean; error?: string }) {
  const [pin, setPin] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(pin); setPin(''); }} className="flex flex-col gap-4">
      {error && <Notice>{error}</Notice>}
      <Field label={label} hint={hint} type="password" inputMode="numeric" pattern="\d{6,12}" maxLength={12} value={pin} autoFocus
        onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))} dir="ltr" className="text-center text-2xl tracking-[0.4em]" />
      <Button type="submit" disabled={pin.length < 6 || busy}>{busy ? 'لحظة…' : 'متابعة'}</Button>
    </form>
  );
}

/** أول استعمال للجهاز: دخول بالحساب، ثم رمز قفل تُشفَّر به بيانات الجهاز. */
export function FirstRun() {
  const { revoked } = useApp();
  const [session, setSession] = useState<{ token: string; user: User } | null>(null);
  const [first, setFirst] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!session) {
    return (
      <Screen title="إيواء — الميدان">
        {revoked && <Notice>سحب مدير النظام هذا الجهاز، فمُحي ما كان عليه. راجعه إن كان ذلك خطأ.</Notice>}
        <p className="text-muted">ادخل بحسابك مرة واحدة والجهاز متصل. بعدها يعمل التطبيق ولو انقطع الاتصال.</p>
        <Credentials submitLabel="دخول" onDone={async (u, p, c) => setSession(await app.signIn(u, p, c))} />
      </Screen>
    );
  }
  return (
    <Screen title="رمز قفل الجهاز">
      <p>مرحباً {session.user.fullName}. ضع رمزاً من ستة أرقام أو أكثر يفتح التطبيق على هذا الجهاز.</p>
      <Notice tone="warn">بيانات العوائل على الجهاز تُشفَّر بهذا الرمز. من نسيه خسر ما لم يُرفع إلى الخادم.</Notice>
      {!first
        ? <PinPad key="a" label="الرمز" hint="من ستة أرقام إلى اثني عشر؛ والأطول أمنع. لا تجعله تاريخ ميلادك." error={error}
            onSubmit={(pin) => { if (/^(\d)\1+$/.test(pin) || '0123456789012'.includes(pin) || '9876543210987'.includes(pin)) setError('رمز سهل التخمين. اختر غيره.'); else { setError(''); setFirst(pin); } }} />
        : <PinPad key="b" label="أعد الرمز للتأكيد" busy={busy} error={error}
            onSubmit={async (pin) => {
              if (pin !== first) { setError('الرمزان مختلفان. أعد من البداية.'); setFirst(''); return; }
              setBusy(true);
              await app.setup(pin, session);
            }} />}
    </Screen>
  );
}

export function Unlock() {
  const { meta } = useApp();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [confirmWipe, setConfirmWipe] = useState(false);
  const wait = Math.max(0, (meta?.lockedUntil ?? 0) - now);
  useEffect(() => {
    if (!wait) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [wait > 0]);
  return (
    <Screen title="إيواء — الميدان">
      <p className="text-lg">{meta?.fullName}</p>
      {wait > 0
        ? <Notice>محاولات خاطئة كثيرة. أعد المحاولة بعد {Math.ceil(wait / 1000)} ثانية.</Notice>
        : <PinPad label="رمز القفل" busy={busy} error={error}
            onSubmit={async (pin) => {
              setBusy(true); setError('');
              const r = await app.unlock(pin);
              setBusy(false); setNow(Date.now());
              if (!r.ok) setError('رمز خاطئ');
            }} />}
      <div className="mt-auto flex flex-col gap-3">
        {confirmWipe ? (
          <>
            <Notice>يُمحى كل ما على هذا الجهاز، ومنه ما لم يُرفع إلى الخادم من تسليمات وتسجيلات. لا رجعة في ذلك.</Notice>
            <Button variant="danger" onClick={() => void app.wipe()}>امحُ الجهاز وابدأ من جديد</Button>
            <Button variant="secondary" onClick={() => setConfirmWipe(false)}>تراجع</Button>
          </>
        ) : <button type="button" className="min-h-12 font-semibold text-muted underline" onClick={() => setConfirmWipe(true)}>نسيت الرمز، أو الجهاز لموظف آخر</button>}
      </div>
    </Screen>
  );
}

/** الجلسة تنتهي بعد 12 ساعة. تُجدَّد بكلمة المرور، وما على الجهاز باقٍ. */
export function Relogin({ onClose }: { onClose: () => void }) {
  const { meta } = useApp();
  return (
    <Screen title="تجديد الجلسة" onBack={onClose}>
      <p>انتهت جلستك مع الخادم. ما سجّلته على الجهاز محفوظ؛ ادخل بكلمة مرورك ليُرفع.</p>
      <Credentials fixedUser={meta?.username} submitLabel="جدّد الجلسة" onDone={async (_u, p, c) => { await app.relogin(p, c); onClose(); }} />
    </Screen>
  );
}
