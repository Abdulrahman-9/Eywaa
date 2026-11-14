import { useState } from 'react';
import { app, pendingCount, useApp } from '../lib/store';
import { Button, Notice, Screen, formatTime } from '../ui';

export type Route = 'home' | 'station' | 'deliver' | 'day' | 'register' | 'outbox' | 'relogin';
const DESK = ['ADMIN', 'DISTRIBUTION_MANAGER', 'DISTRIBUTOR'];
const REGISTRARS = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'];

export function OnlineChip() {
  const { online } = useApp();
  return (
    <span className={`flex flex-none items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${online ? 'bg-white/15' : 'bg-warn-soft text-warn-ink'}`}>
      <span aria-hidden="true" className={`size-2 rounded-full ${online ? 'bg-[#6fd3b8]' : 'bg-warn-ink'}`} />{online ? 'متصل' : 'منقطع'}
    </span>
  );
}

export function Home({ go }: { go: (r: Route) => void }) {
  const s = useApp();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const pending = pendingCount(s);
  const conflicts = s.deliveries.filter((d) => d.sync === 'CONFLICT' || d.sync === 'UNKNOWN').length + s.registrations.filter((r) => r.sync === 'REJECTED').length;
  const role = s.user?.role ?? '';
  const delivered = s.station ? s.deliveries.filter((d) => d.sync !== 'UNKNOWN').length : 0;
  const remaining = s.manifest ? s.manifest.entries.filter((e) => e.status === 'PENDING' && !s.deliveries.some((d) => d.entitlementId === e.id)).length : 0;

  async function sync() {
    setMessage(null);
    const r = await app.sync();
    setMessage({ ok: r.ok, text: r.message });
  }

  return (
    <Screen title="إيواء" status={<OnlineChip />}>
      <div>
        <p className="text-lg font-semibold">{s.user?.fullName}</p>
        <p className="text-sm text-muted">{s.lastSync ? `آخر مزامنة ${formatTime(s.lastSync)}` : 'لم يُزامَن في هذه الجلسة بعد'}</p>
      </div>

      {s.needLogin && <Notice tone="warn">انتهت الجلسة مع الخادم. <button type="button" className="underline" onClick={() => go('relogin')}>جدّدها</button> ليُرفع ما على الجهاز.</Notice>}
      {message && <Notice tone={message.ok ? 'ok' : 'warn'}>{message.text}</Notice>}

      <section aria-label="المزامنة" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-semibold">ينتظر الرفع إلى الخادم</span>
          <strong data-testid="pending" className={`text-3xl tabular-nums ${pending ? 'text-warn-ink' : 'text-brand-strong'}`}>{pending}</strong>
        </div>
        {conflicts > 0 && <button type="button" onClick={() => go('outbox')} className="text-start font-semibold text-danger underline">{conflicts} عملية تحتاج نظرك</button>}
        <Button variant={pending ? 'primary' : 'secondary'} disabled={s.syncing} onClick={() => void sync()}>{s.syncing ? 'جارٍ الرفع…' : 'زامن الآن'}</Button>
      </section>

      {DESK.includes(role) && (
        <section aria-label="التوزيع" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-bold">التوزيع</h2>
          {s.station && s.manifest ? (
            <>
              <p><strong>{s.station.campaignName}</strong><br /><span className="text-muted">{s.station.pointName} · الشبّاك {s.station.lane} من {s.station.lanes}</span></p>
              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="rounded-xl bg-brand-soft px-3 py-2"><div className="text-2xl font-bold tabular-nums text-brand-strong">{delivered}</div><div className="text-sm">سلّمتَ</div></div>
                <div className="rounded-xl bg-ground px-3 py-2"><div className="text-2xl font-bold tabular-nums">{remaining}</div><div className="text-sm">بقي في حصتك</div></div>
              </div>
              <Button onClick={() => go('deliver')}>سلّم</Button>
              <div className="grid grid-cols-2 gap-3">
                <Button variant="secondary" onClick={() => go('day')}>كشف اليوم</Button>
                <Button variant="secondary" onClick={() => go('station')}>غيّر الحملة</Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-muted">حمّل بيان الحملة قبل الخروج إلى النقطة، والجهاز متصل.</p>
              <Button onClick={() => go('station')}>اختر الحملة والنقطة</Button>
            </>
          )}
        </section>
      )}

      {REGISTRARS.includes(role) && (
        <section aria-label="التسجيل" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-bold">تسجيل العوائل</h2>
          <p className="text-muted">يُحفظ على الجهاز ويُرفع حين يتصل. كشف التكرار يقع عند الرفع.</p>
          <Button onClick={() => go('register')}>سجّل عائلة</Button>
          {s.registrations.length > 0 && <Button variant="secondary" onClick={() => go('outbox')}>ما سجّلتَه ({s.registrations.length})</Button>}
        </section>
      )}

      <button type="button" className="mt-auto min-h-12 font-semibold text-muted underline" onClick={() => app.lock()}>اقفل التطبيق</button>
    </Screen>
  );
}
