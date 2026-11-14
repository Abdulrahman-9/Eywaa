import { useState } from 'react';
import { app, custodyOf, inspectionsTodo, pendingCount, rejectedOps, useApp } from '../lib/store';
import { Button, Notice, Screen, formatNumber, formatTime } from '../ui';

export type Route = 'home' | 'station' | 'deliver' | 'day' | 'register' | 'outbox' | 'relogin' | 'visits' | 'grant' | 'custody' | 'boxes' | 'donate' | 'requests' | 'inspect';
const DESK = ['ADMIN', 'DISTRIBUTION_MANAGER', 'DISTRIBUTOR', 'DISTRIBUTION_AGENT'];
const REGISTRARS = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'];
const INSPECTORS = ['DISTRIBUTION_AGENT', 'FIELD_RESEARCHER'];

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
  const conflicts = s.deliveries.filter((d) => d.sync === 'CONFLICT' || d.sync === 'UNKNOWN').length + s.registrations.filter((r) => r.sync === 'REJECTED').length + s.visitReports.filter((r) => r.sync === 'REJECTED').length + s.cases.filter((c) => c.sync === 'REJECTED').length + rejectedOps(s);
  const custody = custodyOf(s);
  const unacked = (s.agentInfo?.goods.transfers.filter((t) => t.needsAck && !s.acks.some((a) => a.moveId === t.id)).length ?? 0);
  const staleBoxes = s.agentInfo?.boxes.filter((b) => b.stale && !s.collections.some((c) => c.boxId === b.id && c.sync === 'PENDING')).length ?? 0;
  const role = s.user?.role ?? '';
  const toInspect = inspectionsTodo(s);
  const agent = role === 'DISTRIBUTION_AGENT';
  const [picking, setPicking] = useState(false);
  const grants = s.grants.filter((g) => new Date(g.expiresAt).getTime() > Date.now());
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
        {conflicts > 0 && <button type="button" onClick={() => go(s.cases.some((c) => c.sync === 'REJECTED') ? 'grant' : s.collections.some((c) => c.sync === 'REJECTED') ? 'boxes' : s.donations.some((d) => d.sync === 'REJECTED') ? 'donate' : s.requests.some((r) => r.sync === 'REJECTED') ? 'requests' : s.inspectionOps.some((o) => o.sync === 'REJECTED') ? 'inspect' : 'outbox')} className="text-start font-semibold text-danger underline">{conflicts} عملية تحتاج نظرك</button>}
        <Button variant={pending ? 'primary' : 'secondary'} disabled={s.syncing} onClick={() => void sync()}>{s.syncing ? 'جارٍ الرفع…' : 'زامن الآن'}</Button>
      </section>

      {DESK.includes(role) && (
        <section aria-label="التوزيع" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-bold">التوزيع</h2>
          {s.station && s.manifest && !picking ? (
            <>
              <p><strong>{s.station.campaignName}</strong><br /><span className="text-muted">{s.station.pointName} · الشبّاك {s.station.lane} من {s.station.lanes}</span></p>
              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="rounded-xl bg-brand-soft px-3 py-2"><div className="text-2xl font-bold tabular-nums text-brand-strong">{delivered}</div><div className="text-sm">سلّمتَ</div></div>
                <div className="rounded-xl bg-ground px-3 py-2"><div className="text-2xl font-bold tabular-nums">{remaining}</div><div className="text-sm">بقي في حصتك</div></div>
              </div>
              <Button onClick={() => go('deliver')}>سلّم</Button>
              <div className="grid grid-cols-2 gap-3">
                <Button variant="secondary" onClick={() => go('day')}>كشف اليوم</Button>
                {agent ? <Button variant="secondary" onClick={() => setPicking(true)}>حصصي</Button> : <Button variant="secondary" onClick={() => go('station')}>غيّر الحملة</Button>}
              </div>
            </>
          ) : (
            <>
              {agent ? (
                <>
                  <p className="text-muted">حصصك من الحملات الجارية. زامن لتتجدد، ثم اختر حصة لتحمّل بيانها والجهاز متصل.</p>
                  <Assignments onLoaded={() => setPicking(false)} />
                </>
              ) : (
                <>
                  <p className="text-muted">حمّل بيان الحملة قبل الخروج إلى النقطة، والجهاز متصل.</p>
                  <Button onClick={() => go('station')}>اختر الحملة والنقطة</Button>
                </>
              )}
            </>
          )}
        </section>
      )}

      {agent && (grants.length > 0 || s.cases.length > 0) && (
        <section aria-label="التخويل" className="flex flex-col gap-3 rounded-2xl border-2 border-[#C8862A] bg-warn-soft p-4">
          <h2 className="text-lg font-bold text-warn-ink">صرف لغير المسجَّلين بتخويل</h2>
          {grants.map((g) => {
            const left = g.maxCases - g.used - s.cases.filter((c) => c.grantId === g.id && c.sync === 'PENDING').length;
            return <p key={g.id}><strong>{g.campaignName}</strong><br />بقي {Math.max(0, left)} من {g.maxCases} · {g.perCase} {g.unit} للحالة · حتى {formatTime(g.expiresAt)}</p>;
          })}
          {grants.length === 0 && <p className="text-warn-ink">لا تخويل سارٍ الآن.</p>}
          <Button onClick={() => go('grant')}>{grants.length ? 'اصرف لغير مسجَّل' : 'ما صرفتَه بتخويل'}</Button>
        </section>
      )}

      {agent && (
        <section aria-label="الذمة والتحصيل" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-baseline justify-between gap-3"><h2 className="text-lg font-bold">في ذمتك نقداً</h2><strong data-testid="home-custody" className="text-3xl tabular-nums">{formatNumber(custody.total)}</strong></div>
          {unacked > 0 && <Notice tone="warn">{unacked} تحويل من المخزن ينتظر أن تؤكد استلامه.</Notice>}
          {staleBoxes > 0 && <Notice tone="warn">{staleBoxes} من صناديقك لم يُفتح منذ أكثر من شهر.</Notice>}
          <div className="grid grid-cols-2 gap-3">
            <Button variant={unacked ? 'primary' : 'secondary'} onClick={() => go('custody')}>ذمتي</Button>
            <Button variant={staleBoxes ? 'primary' : 'secondary'} onClick={() => go('boxes')}>الصناديق ({s.agentInfo?.boxes.length ?? 0})</Button>
            <Button variant="secondary" onClick={() => go('donate')}>تبرع جديد</Button>
            <Button variant="secondary" onClick={() => go('requests')}>طلباتي</Button>
          </div>
        </section>
      )}

      {INSPECTORS.includes(role) && (
        <section aria-label="الكشف الميداني" className={`flex flex-col gap-3 rounded-2xl border bg-surface p-4 ${toInspect.some((t) => t.late) ? 'border-2 border-[#C8862A]' : 'border-line'}`}>
          <h2 className="text-lg font-bold">الكشف الميداني</h2>
          <p className="text-muted">{toInspect.length ? 'عوائل كُلّفتَ بزيارتها: تطابق ما سُجّل بما ترى وترفع ما وجدتَ.' : 'لا كشف مطلوب منك الآن. القائمة تتجدد عند كل مزامنة.'}</p>
          {toInspect.some((t) => t.late) && <Notice tone="warn">{toInspect.filter((t) => t.late).length} منها تأخّر أكثر من أسبوع.</Notice>}
          <Button variant={toInspect.length ? 'primary' : 'secondary'} onClick={() => go('inspect')}>الكشوف المطلوبة ({toInspect.length})</Button>
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

      {REGISTRARS.includes(role) && (
        <section aria-label="إعادة التقييم" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-bold">زيارات إعادة التقييم</h2>
          <p className="text-muted">ما طُلب منك زيارته. القائمة تتجدد عند كل مزامنة.</p>
          <Button variant={s.visits.filter((v) => !s.visitReports.some((r) => r.reassessmentId === v.id)).length ? 'primary' : 'secondary'} onClick={() => go('visits')}>الزيارات المطلوبة ({s.visits.filter((v) => !s.visitReports.some((r) => r.reassessmentId === v.id)).length})</Button>
        </section>
      )}

      <button type="button" className="mt-auto min-h-12 font-semibold text-muted underline" onClick={() => app.lock()}>اقفل التطبيق</button>
    </Screen>
  );
}

/** حصص المتعهد: يختار واحدة فيُحمَّل بيانها. الشبّاك واحد: حصته له وحده. */
function Assignments({ onLoaded }: { onLoaded: () => void }) {
  const s = useApp();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  if (!s.assignments.length) return <Notice tone="warn">لا حصة لك في حملة جارية. زامن، أو راجع مدير التوزيع.</Notice>;
  return (
    <>
      {error && <Notice>{error}</Notice>}
      {s.assignments.map((a) => (
        <Button key={a.campaignId + a.pointId} variant="secondary" disabled={!!busy} className="h-auto min-h-16 flex-col !items-start py-2 text-start"
          onClick={async () => {
            setBusy(a.campaignId); setError('');
            try { await app.loadStation({ campaignId: a.campaignId, pointId: a.pointId, pointName: a.pointName, lane: 1, lanes: 1 }); onLoaded(); }
            catch (e) { setError(e instanceof Error && e.message === 'لا اتصال بالخادم' ? 'تحميل البيان يحتاج اتصالاً.' : e instanceof Error ? e.message : 'تعذّر التحميل'); }
            finally { setBusy(''); }
          }}>
          <span>{a.campaignName}</span>
          <span className="text-sm font-normal text-muted">{busy === a.campaignId ? 'يُحمَّل البيان…' : `${a.families} عائلة · ${a.quantity} ${a.unit} · سلّمتَ ${a.delivered}`}</span>
        </Button>
      ))}
    </>
  );
}
