import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Field, Input, PageHeader, Select } from '../components/ui';
import { api, ApiError, upload } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { Point } from './Campaigns';

interface Receiver { kind: 'HEAD' | 'PROXY'; proxyId?: string; name: string; relation?: string | null }
interface Checked { entitlementId: string; familyNo: string; headName: string; quantity: number; unit: string; campaignName: string; assignedPoint: string; atAssignedPoint: boolean; receivers: Receiver[]; headPhotoUrl: string | null }
interface Delivered { entitlementId: string; familyNo: string; quantity: number; unit: string; receiverName: string; deliveredAt: string; point: string }
type Locate = { token: string } | { campaignId: string; familyNo: string; code: string };

/** معرّف هذا الحاسوب: يُحفظ في المتصفح ليُعرف من أي جهاز خرج كل تسليم. */
function deviceId(): string {
  try {
    let id = localStorage.getItem('eywaa.deviceId');
    if (!id) { id = `web-${crypto.randomUUID().slice(0, 8)}`; localStorage.setItem('eywaa.deviceId', id); }
    return id;
  } catch { return 'web-unknown'; }
}
const remembered = (key: string) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* لا شيء */ } };

/** شبّاك التسليم على الحاسوب: يُمسح الرمز بقارئ يدوي (يكتب كلوحة المفاتيح) أو يُدخل رقم العائلة ورمزها. */
export function Desk() {
  const device = useMemo(deviceId, []);
  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: () => api<{ id: string; name: string; status: string }[]>('/campaigns') });
  const points = useQuery({ queryKey: ['points'], queryFn: () => api<Point[]>('/points') });
  const active = campaigns.data?.filter((c) => c.status === 'ACTIVE') ?? [];
  const [campaignId, setCampaignId] = useState(remembered('eywaa.desk.campaign'));
  const [pointId, setPointId] = useState(remembered('eywaa.desk.point'));
  const [token, setToken] = useState('');
  const [familyNo, setFamilyNo] = useState('');
  const [code, setCode] = useState('');
  const [locate, setLocate] = useState<Locate | null>(null);
  const [receiver, setReceiver] = useState<Receiver | null>(null);
  const [done, setDone] = useState<Delivered | null>(null);
  const [opId, setOpId] = useState(() => crypto.randomUUID());
  const tokenRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // الحملة المحفوظة قد تكون أُقفلت: لا يُعمل إلا بحملة جارية الآن.
  useEffect(() => {
    if (!campaigns.data || active.some((c) => c.id === campaignId)) return;
    setCampaignId(active[0]?.id ?? '');
  }, [campaigns.data, active, campaignId]);
  useEffect(() => { remember('eywaa.desk.campaign', campaignId); remember('eywaa.desk.point', pointId); }, [campaignId, pointId]);

  const check = useMutation({ mutationFn: (l: Locate) => api<Checked>('/deliveries/check', { method: 'POST', body: { pointId, deviceId: device, locate: l } }) });
  const redeem = useMutation({
    mutationFn: () => api<Delivered>('/deliveries/redeem', {
      method: 'POST',
      body: { pointId, deviceId: device, locate, clientOpId: opId, receiver: receiver!.kind === 'HEAD' ? { kind: 'HEAD' } : { kind: 'PROXY', proxyId: receiver!.proxyId } },
    }),
    onSuccess: setDone,
  });
  const proof = useMutation({ mutationFn: (file: File) => { const form = new FormData(); form.set('file', file); return upload(`/deliveries/${done!.entitlementId}/proof`, form); } });

  function reset() {
    setToken(''); setFamilyNo(''); setCode(''); setLocate(null); setReceiver(null); setDone(null); setOpId(crypto.randomUUID());
    check.reset(); redeem.reset(); proof.reset();
    setTimeout(() => tokenRef.current?.focus(), 0);
  }
  function submit(l: Locate) { setLocate(l); setReceiver(null); redeem.reset(); check.mutate(l); }

  const refusal = (check.error ?? redeem.error) as ApiError | null;
  const refusalDetails = refusal instanceof ApiError ? (refusal.details as { code?: string; details?: { familyNo?: string; deliveredAt?: string; point?: string; receiverName?: string } }) : null;
  const ready = active.some((c) => c.id === campaignId) && !!pointId;
  const info = check.data;

  return (
    <>
      <PageHeader title="شبّاك التسليم" description={`الجهاز ${device}. امسح رمز العائلة، ثم اختر من حضر، ثم سلّم.`} />
      <Card className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1"><Field label="الحملة">{(id) => <Select id={id} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>{active.length === 0 && <option value="">لا حملة جارية</option>}{active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field></div>
        <div className="min-w-44 flex-1"><Field label="نقطتك">{(id) => <Select id={id} value={pointId} onChange={(e) => setPointId(e.target.value)}><option value="">اختر النقطة</option>{points.data?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field></div>
      </Card>
      {!ready && <Alert tone="warn">{campaigns.data && active.length === 0 ? 'لا حملة جارية الآن. ' : ''}اختر الحملة ونقطتك لتبدأ التسليم.</Alert>}

      {ready && !info && !done && !refusal && (
        <Card className="flex flex-col gap-5">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (token.trim()) submit({ token: token.trim() }); }}>
            <div className="min-w-64 flex-1"><Field label="امسح الرمز هنا" hint="قارئ الرموز يكتبه ويضغط إدخال وحده">{(id) => <Input id={id} ref={tokenRef as never} dir="ltr" autoFocus autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />}</Field></div>
            <Button type="submit" disabled={!token.trim() || check.isPending}>تحقق</Button>
          </form>
          <form className="flex flex-wrap items-end gap-3 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); submit({ campaignId, familyNo: familyNo.trim(), code: code.trim() }); }}>
            <p className="basis-full font-semibold">أو: رقم العائلة والرمز الرقمي الذي وصلها بالرسالة</p>
            <div className="min-w-40 flex-1"><Field label="رقم العائلة">{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={familyNo} onChange={(e) => setFamilyNo(e.target.value)} />}</Field></div>
            <div className="min-w-40 flex-1"><Field label="الرمز الرقمي">{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />}</Field></div>
            <Button type="submit" variant="secondary" disabled={!familyNo.trim() || code.trim().length < 4 || check.isPending}>تحقق</Button>
          </form>
        </Card>
      )}

      {refusal && !done && (
        <div role="alert" className="flex flex-col gap-4 rounded-xl bg-danger p-6 text-white">
          <strong className="text-3xl">{refusal.message.startsWith('لا تسلّم') ? 'لا تسلّم' : 'تعذّر التحقق'}</strong>
          <span className="text-xl">{refusal.message.replace('لا تسلّم: ', '')}</span>
          {refusalDetails?.code === 'ALREADY_DELIVERED' && refusalDetails.details && (
            <div className="rounded-lg bg-white p-4 text-ink">
              <strong>العائلة {refusalDetails.details.familyNo}</strong>
              <div>استُلم {refusalDetails.details.deliveredAt ? formatDateTime(refusalDetails.details.deliveredAt) : ''} في {refusalDetails.details.point}.</div>
              <div>استلمه: {refusalDetails.details.receiverName}.</div>
              <p className="mt-2 text-sm text-muted">إن قال صاحب الرمز إنه لم يستلم، فأحِله إلى المشرف ولا تسلّمه.</p>
            </div>
          )}
          <Button variant="secondary" className="self-start" onClick={reset}>امسح التالي</Button>
        </div>
      )}

      {info && !done && !refusal && (
        <Card className="flex flex-col gap-4">
          <div className="rounded-lg bg-brand p-4 text-white"><span className="font-semibold">الرمز صحيح</span><div className="text-2xl font-bold">العائلة {info.familyNo}</div></div>
          <div><span className="text-muted">تستحق</span><div className="text-3xl font-bold">{info.quantity} {info.unit}</div></div>
          {info.headPhotoUrl && (
            <figure className="flex items-center gap-4 rounded-lg border border-line p-3">
              <img src={info.headPhotoUrl} alt={`صورة ${info.headName}`} className="size-28 flex-none rounded-lg object-cover" />
              <figcaption><strong>{info.headName}</strong><div className="text-muted">صورة رب الأسرة من ملفه. طابق بها وجه الحاضر إن قال إنه هو.</div></figcaption>
            </figure>
          )}
          {!info.atAssignedPoint && <Alert tone="warn">هذه العائلة معيَّنة لنقطة <strong>{info.assignedPoint}</strong>. يجوز تسليمها هنا لأن الجهاز متصل.</Alert>}
          <fieldset className="flex flex-col gap-2.5">
            <legend className="mb-1 text-lg font-bold">من الحاضر أمامك؟</legend>
            {info.receivers.map((r) => {
              const on = receiver?.kind === r.kind && receiver?.proxyId === r.proxyId;
              return (
                <button key={r.kind + (r.proxyId ?? '')} type="button" aria-pressed={on} onClick={() => setReceiver(r)}
                  className={`flex min-h-16 flex-col justify-center rounded-xl px-4 py-2 text-start ${on ? 'border-[3px] border-brand bg-brand-soft' : 'border border-line-strong bg-surface'}`}>
                  <strong className="text-lg">{r.name}</strong>
                  <span className="text-muted">{r.kind === 'HEAD' ? 'رب الأسرة' : `وكيل مسجَّل${r.relation ? ` (${r.relation})` : ''}`}</span>
                </button>
              );
            })}
          </fieldset>
          <div className="flex flex-wrap justify-between gap-3">
            <Button variant="danger" onClick={reset}>ليس أحدهم: لا تسلّم</Button>
            <Button className="min-h-14 px-8 text-lg" disabled={!receiver || redeem.isPending} onClick={() => redeem.mutate()}>{redeem.isPending ? 'جارٍ التسجيل…' : 'سلّم وسجّل'}</Button>
          </div>
        </Card>
      )}

      {done && (
        <Card className="flex flex-col items-center gap-3 py-8 text-center">
          <div aria-hidden="true" className="flex size-24 items-center justify-center rounded-full bg-brand text-5xl text-white">✓</div>
          <strong className="text-3xl">تمّ التسليم</strong>
          <span className="text-lg">{done.quantity} {done.unit} للعائلة {done.familyNo}</span>
          <span className="text-muted">استلمها {done.receiverName} · {formatDateTime(done.deliveredAt)} · {done.point}</span>
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="صورة التسليم"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) proof.mutate(f); }} />
          {proof.isSuccess ? <Alert tone="ok">حُفظت صورة التسليم في ملف العائلة.</Alert> : <Button variant="secondary" disabled={proof.isPending} onClick={() => cameraRef.current?.click()}>{proof.isPending ? 'جارٍ الرفع…' : 'أضف صورة التسليم (اختيارية)'}</Button>}
          {proof.error && <Alert>{proof.error.message}</Alert>}
          <Button className="min-h-14 px-10 text-lg" onClick={reset}>امسح التالي</Button>
        </Card>
      )}
    </>
  );
}
