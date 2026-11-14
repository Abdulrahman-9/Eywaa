import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Banknote, Boxes, Check, ClipboardCheck, Package, Pencil, Phone, Truck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AgentDonations, type Donation } from '../components/AgentDonations';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Segmented, Select, Skeleton } from '../components/ui';
import { KIND_AR, VoucherDialog } from '../components/Voucher';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { formatAgo, formatDate, formatDateTime, formatDays, formatNumber } from '../lib/format';
import { initials, type AgentRow } from './Agents';
import type { Box, Collection } from './Boxes';

interface Line { id: string; no: string; kind: string; pending: boolean; description: string; party: string | null; at: string; fundId: string; fund: string; in: number; out: number; balance: number; by: string }
interface Transfer { id: string; kind: string; inbound: boolean; item: string; unit: string; quantity: number; at: string; from: string | null; to: string | null; by: string; campaign: string | null; note: string | null; needsAck: boolean; ack: { ok: boolean; note: string | null; at: string } | null }
interface Detail extends AgentRow {
  custodyStatement: { balance: number; funds: { fundId: string; fund: string; balance: number }[]; lines: Line[] };
  goodsDetail: { warehouseId: string | null; balances: { itemId: string; item: string; unit: string; quantity: number }[]; transfers: Transfer[] };
  boxList: Box[]; collections: Collection[]; donations: Donation[];
  campaigns: { campaignId: string; name: string; status: string; unit: string; endsOn: string; point: string; lead: boolean; families: number; delivered: number; lastDelivery: string | null }[];
  requests: {
    additions: { id: string; no: number; headName: string; status: string; at: string; familyNo: string | null; note: string | null }[];
    edits: { id: string; familyNo: string; reason: string; status: string; outcome: string | null; at: string; note: string | null }[];
  };
  timeline: { id: string; at: string; action: string; text: string }[];
}
type Tab = 'activity' | 'cash' | 'goods' | 'boxes' | 'donations' | 'work';

const QUICK_AR: Record<string, string> = { NEW: 'جديد', INVITED: 'دُعي صاحبه', VISIT_ASSIGNED: 'أُسندت زيارته', COMPLETED: 'سُجّلت العائلة', DISMISSED: 'صُرف النظر عنه' };
const EDIT_AR: Record<string, string> = { OPEN: 'ينتظر زيارة', VISITED: 'زيرت وتنتظر الاعتماد', CLOSED: 'أُغلق', CANCELLED: 'أُلغي' };
const int = (v: string) => Number(v.replace(/\D/g, '')) || 0;
const H = ({ cols }: { cols: string[] }) => <thead><tr className="text-muted">{cols.map((h) => <th key={h} scope="col" className="border-b border-line p-2 text-start font-medium">{h}</th>)}</tr></thead>;

export function Agent() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const role = user?.role ?? '';
  const canBook = role === 'ADMIN' || role === 'ACCOUNTANT';
  const q = useQuery({ queryKey: ['agent', id], queryFn: () => api<Detail>(`/agents/${id}`) });
  const [tab, setTab] = useState<Tab>('activity');
  const [receiving, setReceiving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [voucher, setVoucher] = useState<string | null>(null);
  const [r, setR] = useState({ fundId: '', amount: '', note: '' });
  const [p, setP] = useState({ fullName: '', phone: '' });
  const a = q.data;
  useEffect(() => { if (receiving && a) { const f = a.custodyStatement.funds[0]; setR({ fundId: f?.fundId ?? '', amount: f ? String(f.balance) : '', note: '' }); } }, [receiving, a]);
  useEffect(() => { if (editing && a) setP({ fullName: a.fullName, phone: a.phone ?? '' }); }, [editing, a]);
  const refresh = () => { for (const key of ['agent', 'agents', 'accounting']) queryClient.invalidateQueries({ queryKey: [key] }); };
  const receive = useMutation({
    mutationFn: () => api<{ id: string; no: string; remaining: number }>('/accounting/custody/receive', { method: 'POST', body: { fundId: r.fundId, userId: id, amount: int(r.amount), ...(r.note.trim() ? { note: r.note.trim() } : {}) } }),
    onSuccess: (e) => { toast(`استُلم ${formatNumber(int(r.amount))} بالقيد ${e.no}. بقي في ذمته ${formatNumber(e.remaining)}`); setReceiving(false); refresh(); setVoucher(e.id); },
  });
  const save = useMutation({
    mutationFn: () => api(`/users/${id}`, { method: 'PATCH', body: { fullName: p.fullName.trim(), phone: p.phone } }),
    onSuccess: () => { toast('حُفظت بيانات المتعهد'); setEditing(false); refresh(); },
  });
  const point = useMutation({ mutationFn: () => api(`/agents/${id}/point`, { method: 'POST' }), onSuccess: () => { toast('أُنشئت نقطته'); refresh(); } });

  if (q.isPending) return <Skeleton className="h-72 w-full" />;
  if (q.error || !a) return <Alert>{q.error?.message ?? 'المتعهد غير موجود'}</Alert>;
  const fundBalance = a.custodyStatement.funds.find((f) => f.fundId === r.fundId)?.balance ?? 0;
  const unacked = a.goodsDetail.transfers.filter((t) => t.needsAck).length;

  return (
    <>
      <Link to="/agents" className="inline-flex items-center gap-1.5 self-start font-semibold text-brand-strong hover:underline"><ArrowRight aria-hidden="true" className="size-4" />المتعهدون</Link>
      <Card className="flex flex-wrap items-center gap-4">
        <span className="grid size-16 flex-none place-items-center rounded-full bg-brand text-2xl font-bold text-white">{initials(a.fullName)}</span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{a.fullName} {!a.active && <Badge>موقوف</Badge>}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted">
            <span className="inline-flex items-center gap-1.5"><Phone aria-hidden="true" className="size-4" />{a.phone ? <a className="font-semibold text-brand-strong hover:underline" dir="ltr" href={`tel:${a.phone}`}>{a.phone}</a> : 'بلا هاتف'}</span>
            <span>حسابه <bdi>{a.username}</bdi></span><span>منذ <bdi>{formatDate(a.since)}</bdi></span><span>آخر نشاط: {formatAgo(a.lastActivity)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {role === 'ADMIN' && <Button variant="secondary" onClick={() => { save.reset(); setEditing(true); }}><Pencil aria-hidden="true" className="size-4" />عدّل بياناته</Button>}
          {!a.pointId && (role === 'ADMIN' || role === 'DISTRIBUTION_MANAGER') && <Button variant="secondary" loading={point.isPending} onClick={() => point.mutate()}>أنشئ نقطته</Button>}
          {canBook && a.custody > 0 && <Button onClick={() => { receive.reset(); setReceiving(true); }}><Banknote aria-hidden="true" className="size-4" />استلم من ذمته</Button>}
        </div>
      </Card>

      {a.alerts.length > 0 && (
        <Card className="flex flex-col gap-1.5 !border-2 !border-[#C8862A]">
          <h2 className="flex items-center gap-2 text-lg font-bold"><AlertTriangle aria-hidden="true" className="size-5 text-warn-ink" />ما يستوجب النظر</h2>
          <ul className="list-inside list-disc">{a.alerts.map((t) => <li key={t}>{t}</li>)}</ul>
        </Card>
      )}

      <section aria-label="ملخص المتعهد" className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-4">
        {([
          [<Banknote aria-hidden="true" className="size-5" />, 'في ذمته نقداً', formatNumber(a.custody), a.custodyDays !== null ? (a.custodyDays === 0 ? 'دخلت ذمته اليوم' : `${formatDays(a.custodyDays)} دون تسليم`) : a.lastHandover ? `آخر تسليم ${formatAgo(a.lastHandover)}` : 'لم يسلّم بعد'],
          [<Package aria-hidden="true" className="size-5" />, 'مواد في عهدته', formatNumber(a.goods), a.goodsItems ? `في ${a.goodsItems} صنف` : 'مخزنه فارغ'],
          [<Truck aria-hidden="true" className="size-5" />, 'سلّم في 30 يوماً', formatNumber(a.last30.deliveries), a.pendingDeliveries ? `بقي عليه ${formatNumber(a.pendingDeliveries)}` : 'لا حصة باقية'],
          [<ClipboardCheck aria-hidden="true" className="size-5" />, 'كشف في 30 يوماً', formatNumber(a.last30.inspections), a.pendingInspections ? `عليه ${formatNumber(a.pendingInspections)} لم يرفعها` : 'لا كشف عليه'],
          [<Boxes aria-hidden="true" className="size-5" />, 'حصّل في 30 يوماً', formatNumber(a.last30.collected + a.last30.cashDonated), `${a.last30.collections} فتح صندوق · ${a.last30.cashDonations} تبرع`],
        ] as const).map(([icon, label, value, note]) => (
          <Card key={label} className="flex flex-col gap-0.5"><span className="flex items-center gap-2 text-sm text-muted">{icon}{label}</span><span className="text-3xl font-bold leading-tight tabular-nums">{value}</span><span className="text-sm text-muted">{note}</span></Card>
        ))}
      </section>

      <div className="overflow-x-auto pb-1">
        <Segmented label="أقسام ملف المتعهد" value={tab} onChange={setTab} options={[
          ['activity', 'النشاط'], ['cash', 'الذمة النقدية'], ['goods', `المواد${unacked ? ` · ${unacked}` : ''}`], ['boxes', `الصناديق (${a.boxList.length})`],
          ['donations', `التبرعات (${a.donations.length})`], ['work', 'الحملات والطلبات'],
        ]} />
      </div>

      {tab === 'activity' && (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">سجل نشاطه</h2>
          {a.timeline.length === 0 && <p className="text-muted">لم يفعل شيئاً بعد.</p>}
          <ol className="flex flex-col">
            {a.timeline.map((t) => (
              <li key={t.id} className="group relative flex gap-3 pb-4 last:pb-0" data-testid="activity">
                <span aria-hidden="true" className="absolute bottom-0 start-[0.3125rem] top-4 w-px bg-line group-last:hidden" />
                <span aria-hidden="true" className="relative mt-1.5 size-2.5 flex-none rounded-full bg-brand" />
                <div className="min-w-0"><div>{t.text}</div><div className="text-sm text-muted"><bdi>{formatDateTime(t.at)}</bdi></div></div>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {tab === 'cash' && (
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3"><h2 className="flex-1 text-lg font-bold">كشف ذمته النقدية</h2><strong className="text-xl tabular-nums" data-testid="custody-balance">{formatNumber(a.custodyStatement.balance)}</strong></div>
          <p className="text-sm text-muted">ما حصّله من صندوق أو تسلّمه من متبرع دخل ذمته بسند قبض؛ ويخرج منها بتسليم يشهد به المحاسب. العجز والزيادة يُسوَّيان بإقفال الذمة بالعدّ من صفحة الصندوق والمحاسبة.</p>
          {a.custodyStatement.funds.length > 1 && <div className="flex flex-wrap gap-2">{a.custodyStatement.funds.map((f) => <Badge key={f.fundId} tone="info">{f.fund}: {formatNumber(f.balance)}</Badge>)}</div>}
          {a.custodyStatement.lines.length === 0 ? <p className="text-muted">لم يدخل ذمته شيء بعد.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] border-collapse text-sm">
                <H cols={['التاريخ', 'القيد', 'البيان', 'دخل ذمته', 'خرج منها', 'الرصيد']} />
                <tbody>
                  {a.custodyStatement.lines.map((l) => (
                    <tr key={l.id} className={cn('border-b border-line last:border-0', l.pending && 'text-muted')}>
                      <td className="whitespace-nowrap p-2"><bdi>{formatDateTime(l.at)}</bdi></td>
                      <td className="p-2"><button type="button" className="font-semibold text-brand-strong underline tabular-nums" onClick={() => setVoucher(l.id)}><bdi>{l.no}</bdi></button></td>
                      <td className="p-2">{KIND_AR[l.kind] ?? l.kind}: {l.description}{l.party ? ` · ${l.party}` : ''} <span className="text-muted">· {l.fund}</span>{l.pending && <> <Badge tone="warn">ينتظر الاعتماد</Badge></>}</td>
                      <td className="p-2 tabular-nums">{l.in ? formatNumber(l.in) : ''}</td>
                      <td className="p-2 tabular-nums">{l.out ? formatNumber(l.out) : ''}</td>
                      <td className="p-2 font-semibold tabular-nums">{formatNumber(l.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'goods' && (
        <div className="flex flex-wrap items-start gap-5">
          <Card className="flex min-w-0 flex-[1_1_18rem] flex-col gap-3">
            <h2 className="text-lg font-bold">ما في مخزنه الآن</h2>
            {!a.goodsDetail.warehouseId && <p className="text-muted">لا نقطة له، فلا مخزن.</p>}
            {a.goodsDetail.warehouseId && a.goodsDetail.balances.length === 0 && <p className="text-muted">مخزنه فارغ.</p>}
            {a.goodsDetail.balances.map((b) => <div key={b.itemId} className="flex items-center gap-3 border-b border-line pb-2 last:border-0"><span className="flex-1 font-semibold">{b.item}</span><strong className={cn('tabular-nums', b.quantity < 0 && 'text-danger')}>{formatNumber(b.quantity)}</strong><span className="text-muted">{b.unit}</span></div>)}
          </Card>
          <Card className="flex min-w-0 flex-[2_1_26rem] flex-col gap-3">
            <h2 className="text-lg font-bold">ما حُوّل إليه وما أرجعه</h2>
            <p className="text-sm text-muted">المخزن يشهد بالتحويل، والمتعهد يشهد بالاستلام من هاتفه. ما بلّغ فيه عن فرق يسوّيه الجرد.</p>
            {a.goodsDetail.transfers.length === 0 && <p className="text-muted">لا حركة بعد.</p>}
            <ul className="flex flex-col">
              {a.goodsDetail.transfers.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-0">
                  <div className="min-w-0 flex-1"><strong>{t.inbound ? 'دخل' : 'خرج'}: {formatNumber(t.quantity)} {t.unit} {t.item}</strong>
                    <div className="text-sm text-muted">{t.inbound ? (t.from ? `من ${t.from}` : 'وارد تبرع') : `إلى ${t.to}`} · {t.by} · <bdi>{formatDateTime(t.at)}</bdi>{t.campaign ? ` · ${t.campaign}` : ''}{t.ack?.note ? ` · «${t.ack.note}»` : ''}</div></div>
                  {t.needsAck ? <Badge tone="warn">لم يؤكد استلامه</Badge> : t.ack && (t.ack.ok ? <Badge tone="ok"><Check aria-hidden="true" className="inline size-3.5" /> أكّد استلامه</Badge> : <Badge tone="danger">بلّغ عن فرق</Badge>)}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {tab === 'boxes' && (
        <div className="flex flex-wrap items-start gap-5">
          <Card className="flex min-w-0 flex-[1_1_20rem] flex-col gap-3">
            <h2 className="text-lg font-bold">صناديقه</h2>
            {a.boxList.length === 0 && <p className="text-muted">لا صندوق في عهدته. تُعيَّن له من <Link className="font-semibold text-brand-strong underline" to="/boxes">صفحة الصناديق</Link>.</p>}
            {a.boxList.map((b) => (
              <Link key={b.id} to={`/boxes?open=${b.id}`} className="flex flex-wrap items-center gap-3 border-b border-line pb-2.5 last:border-0 hover:text-brand-strong">
                <div className="min-w-0 flex-1"><strong>صندوق <bdi>{b.code}</bdi> — {b.location}</strong><div className="text-sm text-muted">{b.lastOpenedAt ? `آخر فتح ${formatAgo(b.lastOpenedAt)}: ${formatNumber(b.lastAmount ?? 0)}` : 'لم يُفتح بعد'} · المعدَّل {formatNumber(b.average)}</div></div>
                {b.status === 'RETIRED' ? <Badge>مرفوع</Badge> : b.stale && <Badge tone="warn">لم يُفتح منذ {b.daysSince} يوماً</Badge>}
              </Link>
            ))}
          </Card>
          <Card className="flex min-w-0 flex-[2_1_26rem] flex-col gap-3">
            <h2 className="text-lg font-bold">ما حصّله</h2>
            {a.collections.length === 0 && <p className="text-muted">لم يفتح صندوقاً بعد.</p>}
            <ul className="flex flex-col">
              {a.collections.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-0">
                  <div className="min-w-0 flex-1"><strong>صندوق <bdi>{c.code}</bdi> — {c.location}</strong><div className="text-sm text-muted"><bdi>{formatDateTime(c.collectedAt)}</bdi>{c.sealNo ? ` · ختم ${c.sealNo}` : ''}{c.note ? ` · ${c.note}` : ''}</div></div>
                  {c.low && <Badge tone="warn">دون المعتاد ({formatNumber(c.expected ?? 0)})</Badge>}
                  <strong className="tabular-nums">{formatNumber(c.amount)}</strong>
                  {c.entryId && <button type="button" className="font-semibold text-brand-strong underline tabular-nums" onClick={() => setVoucher(c.entryId)}><bdi>{c.entryNo}</bdi></button>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {tab === 'donations' && <Card className="flex flex-col gap-2"><h2 className="text-lg font-bold">تبرعات تسلّمها</h2><AgentDonations agentId={a.id} rows={a.donations} /></Card>}

      {tab === 'work' && (
        <div className="flex flex-wrap items-start gap-5">
          <Card className="flex min-w-0 flex-[1_1_24rem] flex-col gap-3">
            <h2 className="text-lg font-bold">حملاته</h2>
            {a.campaigns.length === 0 && <p className="text-muted">لم يدخل حملة بعد.</p>}
            {a.campaigns.map((c) => (
              <Link key={c.campaignId + c.point} to={`/campaigns/${c.campaignId}`} className="flex flex-col gap-1.5 border-b border-line pb-3 last:border-0 hover:text-brand-strong">
                <div className="flex flex-wrap items-center gap-2"><strong className="flex-1">{c.name}</strong>{c.lead && <Badge tone="info">مسؤول نقطة {c.point}</Badge>}<Badge tone={c.status === 'ACTIVE' ? 'ok' : 'neutral'}>{c.status === 'ACTIVE' ? 'جارية' : 'أُقفلت'}</Badge></div>
                <div className="h-2 overflow-hidden rounded-full bg-ground"><div className="h-full rounded-full bg-brand" style={{ width: `${c.families ? Math.round((c.delivered / c.families) * 100) : 0}%` }} /></div>
                <div className="text-sm text-muted">سلّم {formatNumber(c.delivered)} من {formatNumber(c.families)} عائلة{c.lastDelivery ? ` · آخر تسليم ${formatAgo(c.lastDelivery)}` : ''}</div>
              </Link>
            ))}
          </Card>
          <Card className="flex min-w-0 flex-[1_1_24rem] flex-col gap-3">
            <h2 className="text-lg font-bold">طلباته</h2>
            {a.requests.additions.length + a.requests.edits.length === 0 && <p className="text-muted">لم يرفع طلباً بعد.</p>}
            {a.requests.additions.map((x) => (
              <div key={x.id} className="flex flex-wrap items-center gap-3 border-b border-line pb-2.5 last:border-0">
                <div className="min-w-0 flex-1"><strong>إضافة: {x.headName}</strong><div className="text-sm text-muted">طلب <bdi>{x.no}</bdi> · <bdi>{formatDate(x.at)}</bdi>{x.familyNo ? ` · صارت العائلة ${x.familyNo}` : ''}{x.note ? ` · ${x.note}` : ''}</div></div>
                <Badge tone={x.status === 'COMPLETED' ? 'ok' : x.status === 'DISMISSED' ? 'neutral' : 'warn'}>{QUICK_AR[x.status] ?? x.status}</Badge>
              </div>
            ))}
            {a.requests.edits.map((x) => (
              <div key={x.id} className="flex flex-wrap items-center gap-3 border-b border-line pb-2.5 last:border-0">
                <div className="min-w-0 flex-1"><strong>تعديل العائلة <bdi>{x.familyNo}</bdi></strong><div className="text-sm text-muted">{x.reason} · <bdi>{formatDate(x.at)}</bdi>{x.note ? ` · ${x.note}` : ''}</div></div>
                <Badge tone={x.status === 'CLOSED' ? 'ok' : x.status === 'CANCELLED' ? 'neutral' : 'warn'}>{EDIT_AR[x.status] ?? x.status}</Badge>
              </div>
            ))}
          </Card>
        </div>
      )}

      <Dialog open={receiving} title="استلام من ذمة المتعهد" onClose={() => setReceiving(false)}>
        <p>يسلّمك <strong>{a.fullName}</strong> نقداً مما في ذمته، فيدخل نقد الصندوق ويبقى الباقي عليه. عُدَّ المبلغ بيدك قبل التسجيل.</p>
        {receive.error && <Alert>{receive.error.message}</Alert>}
        <Field label="من أي صندوق">{(fid) => <Select id={fid} value={r.fundId} onChange={(e) => { const f = a.custodyStatement.funds.find((x) => x.fundId === e.target.value); setR({ ...r, fundId: e.target.value, amount: f ? String(f.balance) : '' }); }}>{a.custodyStatement.funds.map((f) => <option key={f.fundId} value={f.fundId}>{f.fund} (في ذمته {formatNumber(f.balance)})</option>)}</Select>}</Field>
        <Field label="المبلغ المستلَم بالدينار" error={int(r.amount) > fundBalance ? `في ذمته ${formatNumber(fundBalance)} فقط. إن زاد النقد عن الدفتر فأقفل الذمة بالعدّ.` : undefined} hint={int(r.amount) > 0 && int(r.amount) < fundBalance ? `يبقى في ذمته ${formatNumber(fundBalance - int(r.amount))}` : undefined}>
          {(fid) => <Input id={fid} dir="ltr" inputMode="numeric" value={r.amount} onChange={(e) => setR({ ...r, amount: e.target.value })} />}
        </Field>
        <Field label="ملاحظة (اختيارية)">{(fid) => <Input id={fid} value={r.note} onChange={(e) => setR({ ...r, note: e.target.value })} />}</Field>
        <div className="flex flex-wrap justify-end gap-3"><Button variant="secondary" onClick={() => setReceiving(false)}>إلغاء</Button><Button loading={receive.isPending} disabled={!r.fundId || int(r.amount) <= 0 || int(r.amount) > fundBalance} onClick={() => receive.mutate()}>سجّل الاستلام</Button></div>
      </Dialog>
      <Dialog open={editing} title="بيانات المتعهد" onClose={() => setEditing(false)}>
        {save.error && <Alert>{save.error.message}</Alert>}
        <Field label="الاسم الكامل">{(fid) => <Input id={fid} value={p.fullName} onChange={(e) => setP({ ...p, fullName: e.target.value })} />}</Field>
        <Field label="رقم الهاتف" hint="يظهر للمتبرعين وأصحاب مواقع الصناديق">{(fid) => <Input id={fid} dir="ltr" inputMode="tel" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} />}</Field>
        <div className="flex flex-wrap justify-end gap-3"><Button variant="secondary" onClick={() => setEditing(false)}>إلغاء</Button><Button loading={save.isPending} disabled={p.fullName.trim().length < 2 || !p.phone.trim()} onClick={() => save.mutate()}>احفظ</Button></div>
      </Dialog>
      <VoucherDialog id={voucher} onClose={() => setVoucher(null)} />
    </>
  );
}
