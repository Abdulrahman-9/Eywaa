import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatNumber } from '../lib/format';
import type { Point } from './Campaigns';
import { CLASS_AR } from './Scoring';

interface Preview { recipients: number; byChannel: Record<string, number>; needsApproval: boolean; threshold: number; sample: string | null; smsParts: number; driver: { name: string; live: boolean } }
interface Row { id: string; kind: string; title: string; status: 'PENDING_APPROVAL' | 'SENT' | 'REJECTED'; recipients: number; createdAt: string; createdBy: string | null; sent: number; failed: number; queued: number; noPhone: number }
interface Detail { id: string; title: string; body: string; status: string; recipients: number; byStatus: Record<string, number>; byChannel: Record<string, number>; problems: { familyId: string; familyNo: string; headName: string; status: string; error: string | null }[] }

const CHANNEL_AR: Record<string, string> = { WHATSAPP: 'واتساب', SMS: 'رسالة نصية', VOICE: 'مكالمة', NO_PHONE: 'بلا هاتف' };
const STATUS = { PENDING_APPROVAL: ['ينتظر الاعتماد', 'warn'], SENT: ['أُرسل', 'ok'], REJECTED: ['مرفوض', 'danger'] } as const;
const GENERAL = ['الاسم', 'رقم_العائلة'];
const CAMPAIGN_VARS = ['النقطة', 'آخر_موعد', 'المقدار', 'الرمز_الرقمي'];

export function Notify() {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: () => api<{ id: string; name: string; status: string }[]>('/campaigns') });
  const points = useQuery({ queryKey: ['points'], queryFn: () => api<Point[]>('/points') });
  const history = useQuery({ queryKey: ['notifications'], queryFn: () => api<Row[]>('/notifications') });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('السلام عليكم {الاسم}. ');
  const [campaignId, setCampaignId] = useState('');
  const [pendingOnly, setPendingOnly] = useState(true);
  const [pointId, setPointId] = useState('');
  const [classes, setClasses] = useState<string[]>([]);
  const [mahalla, setMahalla] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ id: string; approve: boolean } | null>(null);

  const audience: Record<string, unknown> = {};
  if (campaignId) { audience.campaignId = campaignId; if (pendingOnly) audience.pendingOnly = true; if (pointId) audience.pointId = pointId; }
  if (classes.length) audience.classes = classes;
  if (mahalla.trim()) audience.mahalla = mahalla.trim();
  const payload = { title: title.trim() || 'بلا عنوان', body: body.trim(), audience };
  const [debounced, setDebounced] = useState(payload);
  const key = JSON.stringify(payload);
  useEffect(() => { const t = setTimeout(() => setDebounced(JSON.parse(key)), 400); return () => clearTimeout(t); }, [key]);
  const preview = useQuery({
    queryKey: ['notify-preview', JSON.stringify(debounced)],
    queryFn: () => api<Preview>('/notifications/preview', { method: 'POST', body: debounced }),
    enabled: debounced.body.length >= 5,
    retry: false,
  });
  const detail = useQuery({ queryKey: ['notification', open], queryFn: () => api<Detail>(`/notifications/${open}`), enabled: !!open });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const send = useMutation({
    mutationFn: () => api<Detail>('/notifications', { method: 'POST', body: { ...payload, title: title.trim() } }),
    onSuccess: (d) => { toast(d.status === 'PENDING_APPROVAL' ? 'أُرسل الطلب إلى الاعتماد' : `خرجت ${formatNumber(d.recipients)} رسالة`); setConfirming(false); setTitle(''); refresh(); },
  });
  const decide = useMutation({
    mutationFn: (note: string) => api(`/notifications/${deciding!.id}/${deciding!.approve ? 'approve' : 'reject'}`, { method: 'POST', body: note ? { note } : {} }),
    onSuccess: () => { toast(deciding!.approve ? 'اعتُمد الإرسال وخرجت الرسائل' : 'رُفض الإرسال'); setDeciding(null); refresh(); },
  });
  const p = preview.data;
  const canApprove = user?.role === 'ADMIN' || user?.role === 'DISTRIBUTION_MANAGER';

  return (
    <>
      <PageHeader title="التنبيهات" description="رسالة واحدة إلى عوائل تختارها. تصل بالواتساب، ثم الرسالة النصية إن أخفق، والمكالمة لمن لا يقرأ." />
      {p && !p.driver.live && (
        <Alert tone="warn"><strong>وضع المحاكاة: الرسائل تُسجَّل ولا تصل إلى أي هاتف.</strong> لم يُربط النظام بعدُ بحساب واتساب للأعمال ولا بمزوّد رسائل ومكالمات. كل ما سواه يعمل كما سيعمل بعد الربط.</Alert>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <Card className="flex min-w-0 flex-[2_1_30rem] flex-col gap-5">
          <fieldset className="flex flex-col gap-3">
            <legend className="text-lg font-bold">1. إلى مَن؟</legend>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
              <Field label="الحملة">
                {(id) => <Select id={id} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}><option value="">كل العوائل المعتمدة</option>{campaigns.data?.filter((c) => c.status === 'ACTIVE').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
              </Field>
              {campaignId && <Field label="النقطة">{(id) => <Select id={id} value={pointId} onChange={(e) => setPointId(e.target.value)}><option value="">كل النقاط</option>{points.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>}
              <Field label="المحلة (اختياري)">{(id) => <Input id={id} value={mahalla} onChange={(e) => setMahalla(e.target.value)} />}</Field>
            </div>
            {campaignId && <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} />من لم يستلم بعد فقط</label>}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">الفئة:</span>
              {Object.entries(CLASS_AR).map(([k, v]) => (
                <label key={k} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-3.5">
                  <input type="checkbox" className="size-[18px] accent-brand" checked={classes.includes(k)} onChange={(e) => setClasses(e.target.checked ? [...classes, k].sort() : classes.filter((x) => x !== k))} />{v}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3 border-t border-line pt-4">
            <legend className="text-lg font-bold">2. الرسالة</legend>
            <Field label="عنوان الإرسال (لك لا للعائلة)">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثال: تذكير بموعد الاستلام" />}</Field>
            <Field label="النص">
              {(id) => <textarea id={id} rows={4} value={body} onChange={(e) => setBody(e.target.value)} className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 leading-loose" />}
            </Field>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">أدرج:</span>
              {[...GENERAL, ...(campaignId ? CAMPAIGN_VARS : [])].map((v) => (
                <button key={v} type="button" onClick={() => setBody((b) => `${b}{${v}}`)} className="min-h-9 rounded-lg border border-line-strong bg-surface px-2.5 font-semibold hover:bg-ground">{`{${v}}`}</button>
              ))}
            </div>
          </fieldset>

          {preview.error && <Alert>{preview.error.message}</Alert>}
          {p && (
            <div role="status" className="rounded-lg bg-brand-soft p-4">
              <strong className="text-lg">{formatNumber(p.recipients)} عائلة</strong> تطابق الاختيار:
              {' '}{Object.entries(p.byChannel).filter(([, n]) => n > 0).map(([c, n]) => `${formatNumber(n)} ${CHANNEL_AR[c]}`).join('، ') || 'لا أحد'}.
              {p.smsParts > 1 && <div className="text-sm text-warn-ink">النص طويل: يخرج في {p.smsParts} رسائل نصية لكل عائلة.</div>}
            </div>
          )}
          {p?.needsApproval && <Alert tone="warn"><strong>هذا الإرسال فوق {formatNumber(p.threshold)} رسالة.</strong> لا يخرج حتى يعتمده مدير توزيع آخر أو مدير النظام.</Alert>}
          <div className="flex justify-end">
            <Button disabled={!p || p.recipients === 0 || title.trim().length < 3 || !!preview.error || preview.isFetching} onClick={() => setConfirming(true)}>
              {p?.needsApproval ? 'اطلب اعتماد الإرسال' : `أرسل إلى ${p ? formatNumber(p.recipients) : '…'} عائلة`}
            </Button>
          </div>
        </Card>

        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-5">
          <Card className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">كما تراها العائلة</h2>
            <div className="rounded-xl bg-[#E9EDEA] p-4">
              {p?.sample ? <div className="inline-block max-w-full whitespace-pre-wrap rounded-xl bg-white px-3.5 py-2.5 leading-loose">{p.sample}</div> : <span className="text-muted">اكتب النص ليظهر هنا بأسماء حقيقية.</span>}
            </div>
          </Card>
          <Card className="flex flex-col gap-2.5">
            <h2 className="text-lg font-bold">ما أُرسل</h2>
            {history.isPending && <Skeleton />}
            {history.data?.length === 0 && <p className="text-muted">لم يُرسل شيء بعد.</p>}
            {history.data?.map((n) => (
              <div key={n.id} className="flex flex-col gap-1 border-b border-line pb-2.5 last:border-0">
                <div className="flex items-center justify-between gap-3"><button type="button" onClick={() => setOpen(n.id)} className="min-h-9 text-start font-semibold text-brand-strong underline">{n.title}</button><Badge tone={STATUS[n.status][1]}>{STATUS[n.status][0]}</Badge></div>
                <span className="text-sm text-muted">{formatNumber(n.recipients)} عائلة{n.status === 'SENT' ? ` · خرج ${formatNumber(n.sent)}${n.queued ? ` · في الطابور ${formatNumber(n.queued)}` : ''}${n.failed ? ` · أخفق ${formatNumber(n.failed)}` : ''}${n.noPhone ? ` · بلا هاتف ${formatNumber(n.noPhone)}` : ''}` : ''} · {n.createdBy ?? 'النظام'} · {formatDateTime(n.createdAt)}</span>
                {n.status === 'PENDING_APPROVAL' && canApprove && n.createdBy !== user?.username && (
                  <div className="flex gap-2"><Button variant="danger" onClick={() => setDeciding({ id: n.id, approve: false })}>رفض</Button><Button onClick={() => setDeciding({ id: n.id, approve: true })}>اعتماد الإرسال</Button></div>
                )}
              </div>
            ))}
          </Card>
        </div>
      </div>

      <Dialog open={confirming} title={p?.needsApproval ? 'طلب اعتماد الإرسال' : 'تأكيد الإرسال'} onClose={() => { send.reset(); setConfirming(false); }}>
        <p>{p?.needsApproval ? 'سيُعرض هذا الإرسال على المعتمِد:' : 'ستخرج الرسالة الآن إلى'} <strong>{p ? formatNumber(p.recipients) : ''} عائلة</strong>.</p>
        {p?.sample && <div className="whitespace-pre-wrap rounded-lg bg-ground p-3 leading-loose">{p.sample}</div>}
        {send.error && <Alert>{send.error.message}</Alert>}
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setConfirming(false)}>تراجع</Button>
          <Button disabled={send.isPending} onClick={() => send.mutate()}>{p?.needsApproval ? 'اطلب الاعتماد' : 'أرسل الآن'}</Button>
        </div>
      </Dialog>

      <Dialog open={!!open} title={detail.data?.title ?? 'تفصيل الإرسال'} onClose={() => setOpen(null)}>
        {detail.isPending ? <Skeleton className="h-24 w-full" /> : detail.data && (
          <>
            <div className="whitespace-pre-wrap rounded-lg bg-ground p-3 leading-loose">{detail.data.body}</div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5">
              <span>خرجت</span><strong className="tabular-nums">{formatNumber((detail.data.byStatus.SENT ?? 0) + (detail.data.byStatus.DELIVERED ?? 0) + (detail.data.byStatus.READ ?? 0))}</strong>
              {Object.entries(detail.data.byChannel).map(([c, n]) => <div key={c} className="contents text-muted"><span className="ps-4">منها {CHANNEL_AR[c]}</span><span className="tabular-nums">{formatNumber(n)}</span></div>)}
              <span className="text-danger">أخفقت</span><strong className="tabular-nums text-danger">{formatNumber(detail.data.byStatus.FAILED ?? 0)}</strong>
              <span>بلا هاتف</span><strong className="tabular-nums">{formatNumber(detail.data.byStatus.NO_PHONE ?? 0)}</strong>
            </div>
            {detail.data.problems.length > 0 && (
              <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-sm">
                {detail.data.problems.map((x) => <li key={x.familyId} className="flex justify-between gap-3"><Link to={`/families/${x.familyId}`} className="font-semibold text-brand-strong">{x.familyNo} · {x.headName}</Link><span>{x.status === 'NO_PHONE' ? 'بلا هاتف' : x.error}</span></li>)}
              </ul>
            )}
            <div className="flex justify-end"><Button variant="secondary" onClick={() => setOpen(null)}>إغلاق</Button></div>
          </>
        )}
      </Dialog>
      <ReasonDialog open={deciding !== null} danger={deciding?.approve === false} required={deciding?.approve === false}
        title={deciding?.approve ? 'اعتماد الإرسال' : 'رفض الإرسال'} confirmLabel={deciding?.approve ? 'اعتماد الإرسال' : 'رفض الإرسال'}
        pending={decide.isPending} error={decide.error?.message} onClose={() => { decide.reset(); setDeciding(null); }} onConfirm={(note) => decide.mutate(note)}>
        <p>{deciding?.approve ? 'تخرج الرسائل فور الاعتماد، إلى من يطابق الاختيار الآن.' : 'لا يخرج شيء.'}</p>
      </ReasonDialog>
    </>
  );
}
