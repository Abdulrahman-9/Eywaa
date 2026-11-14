import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { app, getState, useApp } from '../lib/store';
import { Button, Notice, Screen, SelectField } from '../ui';

interface Campaign { id: string; name: string; status: string; unit: string; families: number; delivered: number }
interface Point { id: string; name: string; assigned: number; delivered: number }

/** اختيار الحملة والنقطة والشبّاك، وتحميل البيان. يحتاج اتصالاً. */
export function StationSetup({ onBack, onReady }: { onBack: () => void; onReady: () => void }) {
  const s = useApp();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [campaignId, setCampaignId] = useState(s.station?.campaignId ?? '');
  const [points, setPoints] = useState<Point[]>([]);
  const [pointId, setPointId] = useState(s.station?.pointId ?? '');
  const [lanes, setLanes] = useState(s.station?.lanes ?? 1);
  const [lane, setLane] = useState(s.station?.lane ?? 1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const unsynced = s.deliveries.filter((d) => d.sync === 'PENDING').length;
  const explain = (err: unknown) => setError(err instanceof ApiError && err.offline ? 'تحميل البيان يحتاج اتصالاً. اتصل ثم أعد المحاولة.' : err instanceof ApiError && err.status === 401 ? 'انتهت الجلسة. ارجع وجدّدها.' : err instanceof Error ? err.message : 'تعذّر التحميل');

  useEffect(() => {
    api<Campaign[]>('/campaigns', { token: getState().token }).then((all) => {
      const active = all.filter((c) => c.status === 'ACTIVE');
      setCampaigns(active);
      if (!active.some((c) => c.id === campaignId)) setCampaignId(active[0]?.id ?? '');
    }).catch(explain);
  }, []);
  useEffect(() => {
    if (!campaignId) { setPoints([]); return; }
    api<{ points: Point[] }>(`/campaigns/${campaignId}`, { token: getState().token }).then((c) => {
      setPoints(c.points);
      setPointId((cur) => (c.points.some((p) => p.id === cur) ? cur : c.points[0]?.id ?? ''));
    }).catch(explain);
  }, [campaignId]);

  async function load() {
    setBusy(true); setError('');
    try {
      await app.loadStation({ campaignId, pointId, pointName: points.find((p) => p.id === pointId)?.name ?? '', lane, lanes });
      onReady();
    } catch (err) { explain(err); } finally { setBusy(false); }
  }

  return (
    <Screen title="الحملة والنقطة" onBack={onBack}>
      {error && <Notice>{error}</Notice>}
      {unsynced > 0 && <Notice tone="warn">على الجهاز {unsynced} تسليم لم يُرفع. زامن قبل أن تغيّر الحملة.</Notice>}
      {campaigns && campaigns.length === 0 && <Notice tone="warn">لا حملة جارية الآن.</Notice>}
      <SelectField label="الحملة" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>{(campaigns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField>
      <SelectField label="نقطة التوزيع" value={pointId} onChange={(e) => setPointId(e.target.value)}>{points.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.assigned} عائلة)</option>)}</SelectField>
      <div className="grid grid-cols-2 gap-3">
        <SelectField label="عدد الشبابيك في النقطة" value={lanes} onChange={(e) => { const n = Number(e.target.value); setLanes(n); setLane((l) => Math.min(l, n)); }}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</SelectField>
        <SelectField label="شبّاكك" value={lane} onChange={(e) => setLane(Number(e.target.value))}>{Array.from({ length: lanes }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</SelectField>
      </div>
      <p className="text-sm text-muted">إن عمل في النقطة أكثر من جهاز فليأخذ كل جهاز شبّاكاً غير شبّاك صاحبه، وليتفقوا على العدد. بهذا لا يُقبل رمز في جهازين والاتصال منقطع.</p>
      <Button className="mt-auto" disabled={busy || !campaignId || !pointId || unsynced > 0} onClick={() => void load()}>{busy ? 'يُحمَّل البيان…' : 'حمّل البيان'}</Button>
    </Screen>
  );
}
