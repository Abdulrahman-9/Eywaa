import { app, useApp } from '../lib/store';
import { Button, Notice, Screen, formatTime } from '../ui';

const SYNC_AR = { PENDING: 'ينتظر الرفع', SYNCED: 'وصل الخادم', CONFLICT: 'سُلِّم قبلك', UNKNOWN: 'لا يعرفه الخادم', REJECTED: 'لم يقبله الخادم' } as const;

/** كشف اليوم: ما سلّمه هذا الجهاز، وما بقي من حصته. */
export function Day({ onBack }: { onBack: () => void }) {
  const s = useApp();
  const mine = [...s.deliveries].sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
  const good = mine.filter((d) => d.sync === 'PENDING' || d.sync === 'SYNCED');
  const quantity = good.reduce((n, d) => n + d.quantity, 0);
  const remaining = s.manifest ? s.manifest.entries.filter((e) => e.status === 'PENDING' && !mine.some((d) => d.entitlementId === e.id)) : [];
  return (
    <Screen title="كشف اليوم" onBack={onBack}>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[['سلّمتَ', good.length], [`${s.station?.unit ?? ''}`, quantity], ['بقي', remaining.length]].map(([label, n]) => (
          <div key={label as string} className="rounded-xl border border-line bg-surface px-2 py-3"><div className="text-2xl font-bold tabular-nums">{n}</div><div className="text-sm text-muted">{label}</div></div>
        ))}
      </div>
      <p className="text-sm text-muted">عند الإقفال: ما سلّمتَه ({quantity} {s.station?.unit}) مع ما بقي عندك يساوي ما استلمتَه من المخزن. والفرق يُسأل عنه.</p>
      <ul className="flex flex-col gap-2">
        {mine.map((d) => (
          <li key={d.clientOpId} className="rounded-xl border border-line bg-surface px-4 py-3">
            <div className="flex items-baseline justify-between gap-2"><strong>{d.receiverName}</strong><span className="text-sm tabular-nums text-muted">{formatTime(d.deliveredAt)}</span></div>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span>العائلة {d.familyNo} · {d.quantity} {d.unit}{d.receiver === 'PROXY' && ' · وكيل'}</span>
              <span className={`font-semibold ${d.sync === 'SYNCED' ? 'text-brand-strong' : d.sync === 'PENDING' ? 'text-warn-ink' : 'text-danger'}`}>{SYNC_AR[d.sync]}</span>
            </div>
            {d.sync === 'REJECTED' && <p className="mt-1 text-sm text-danger">{d.error} رُفع بلاغ إلى مدير التوزيع؛ راجعه بهذا التسليم.</p>}
            {d.sync === 'CONFLICT' && <p className="mt-1 text-sm text-danger">وجده الخادم مسلَّماً{d.conflict?.first?.receiverName ? ` إلى ${d.conflict.first.receiverName}` : ''}{d.conflict?.first?.point ? ` في ${d.conflict.first.point}` : ''}. رُفع بلاغ إلى مدير التوزيع.</p>}
          </li>
        ))}
        {mine.length === 0 && <li className="py-8 text-center text-muted">لم تسلّم شيئاً بعد.</li>}
      </ul>
    </Screen>
  );
}

const REG_AR: Record<string, string> = { PENDING_APPROVAL: 'بانتظار الاعتماد', PENDING_DEDUPE_REVIEW: 'عُلّقت لشبهة تكرار', APPROVED: 'معتمدة', REJECTED: 'مرفوضة' };

/** ما على الجهاز من تسجيلات، وما ردّه الخادم منها. */
export function Outbox({ onBack }: { onBack: () => void }) {
  const s = useApp();
  const conflicts = s.deliveries.filter((d) => d.sync === 'CONFLICT' || d.sync === 'UNKNOWN' || d.sync === 'REJECTED');
  return (
    <Screen title="ما على الجهاز" onBack={onBack}>
      {conflicts.length > 0 && <Notice>{conflicts.length} تسليم خالف ما في الخادم. تفصيله في «كشف اليوم»، وقد رُفع به بلاغ.</Notice>}
      <h2 className="text-lg font-bold">العوائل المسجَّلة</h2>
      <ul className="flex flex-col gap-2">
        {[...s.registrations].reverse().map((r) => (
          <li key={r.clientOpId} className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3">
            <div className="flex items-baseline justify-between gap-2"><strong>{r.headName}</strong><span className="text-sm tabular-nums text-muted">{formatTime(r.createdAt)}</span></div>
            {r.sync === 'PENDING' && <span className="font-semibold text-warn-ink">ينتظر الرفع</span>}
            {r.sync === 'SYNCED' && <span className="font-semibold text-brand-strong">رقم العائلة {r.familyNo} · {REG_AR[r.status ?? ''] ?? r.status}</span>}
            {r.sync === 'REJECTED' && (
              <>
                <span className="font-semibold text-danger">رفضه الخادم: {r.error}</span>
                <Button variant="secondary" className="min-h-11 self-start text-base" onClick={() => void app.dropRegistration(r.clientOpId)}>أزله من الجهاز</Button>
              </>
            )}
          </li>
        ))}
        {s.registrations.length === 0 && <li className="py-8 text-center text-muted">لا تسجيلات على الجهاز.</li>}
      </ul>
    </Screen>
  );
}
