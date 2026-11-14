import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Banknote, Boxes, HandCoins, Package, Phone, Truck, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AgentDonations } from '../components/AgentDonations';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, CountUp, Dialog, Field, Input, PageHeader, Segmented, Skeleton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { formatAgo, formatNumber } from '../lib/format';

export interface AgentRow {
  id: string; fullName: string; username: string; phone: string | null; active: boolean; since: string; pointId: string | null;
  custody: number; custodyDays: number | null; lastHandover: string | null; goods: number; goodsItems: number; boxes: number; staleBoxes: number;
  pendingDeliveries: number; openReports: number; unacked: number; disputes: number;
  last30: { deliveries: number; collections: number; collected: number; cashDonations: number; cashDonated: number; inKindDonations: number; additions: number; edits: number };
  lastActivity: string | null; alerts: string[];
}
interface Overview {
  agents: AgentRow[];
  totals: { agents: number; custody: number; withAlerts: number; openReports: number; deliveries30: number; collected30: number };
  limits: { custodyStaleDays: number; boxStaleDays: number };
}

export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join(' ');

function Tile({ icon, label, value, note, tone }: { icon: React.ReactNode; label: string; value: number; note?: string; tone?: 'warn' }) {
  return (
    <Card className={cn('flex items-center gap-4', tone === 'warn' && value > 0 && '!border-[#C8862A]')}>
      <span className={cn('grid size-12 flex-none place-items-center rounded-xl', tone === 'warn' && value > 0 ? 'bg-warn-soft text-warn-ink' : 'bg-brand-soft text-brand-strong')}>{icon}</span>
      <div className="min-w-0"><div className="text-sm text-muted">{label}</div><div className="text-2xl font-bold leading-tight"><CountUp value={value} /></div>{note && <div className="text-sm text-muted">{note}</div>}</div>
    </Card>
  );
}

function AddAgent({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [f, setF] = useState({ fullName: '', phone: '', username: '', password: '' });
  const create = useMutation({
    mutationFn: async () => {
      const u = await api<{ id: string }>('/users', { method: 'POST', body: { ...f, fullName: f.fullName.trim(), role: 'DISTRIBUTION_AGENT' } });
      // نقطته تُنشأ معه: بها يدخل الحملات ويُحوَّل إلى مخزنه.
      await api(`/agents/${u.id}/point`, { method: 'POST' });
      return u;
    },
    onSuccess: (u) => { queryClient.invalidateQueries({ queryKey: ['agents'] }); toast('أُضيف المتعهد وأُنشئت نقطته'); setF({ fullName: '', phone: '', username: '', password: '' }); onClose(); navigate(`/agents/${u.id}`); },
  });
  const details = create.error instanceof ApiError ? (create.error.details as { errors?: { path: string; message: string }[] }) : null;
  const errors = Object.fromEntries((details?.errors ?? []).map((e) => [e.path, e.message]));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open={open} title="إضافة متعهد" onClose={() => { create.reset(); onClose(); }}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <p className="text-muted">المتعهد يد المركز في الميدان. اسمه وهاتفه يظهران للمتبرعين وأصحاب مواقع الصناديق في رسائل الإشعار.</p>
        {create.error && Object.keys(errors).length === 0 && <Alert>{create.error.message}</Alert>}
        <Field label="الاسم الكامل" error={errors.fullName}>{(id) => <Input id={id} value={f.fullName} onChange={set('fullName')} required />}</Field>
        <Field label="رقم الهاتف" error={errors.phone} hint="مثل 07701234567">{(id) => <Input id={id} dir="ltr" inputMode="tel" value={f.phone} onChange={set('phone')} required />}</Field>
        <Field label="اسم المستخدم" error={errors.username} hint="حروف لاتينية صغيرة وأرقام: يدخل به تطبيق الهاتف">{(id) => <Input id={id} dir="ltr" autoComplete="off" value={f.username} onChange={set('username')} required />}</Field>
        <Field label="كلمة مرور مؤقتة" error={errors.password} hint="12 خانة على الأقل">{(id) => <Input id={id} dir="ltr" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required />}</Field>
        <div className="flex flex-wrap justify-end gap-3"><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button type="submit" loading={create.isPending} disabled={f.fullName.trim().length < 2 || !f.phone || !f.username || f.password.length < 12}>أضف المتعهد</Button></div>
      </form>
    </Dialog>
  );
}

function AgentCard({ a }: { a: AgentRow }) {
  const figure = (icon: React.ReactNode, label: string, value: string, strong?: boolean) => (
    <div className="flex items-center gap-2"><span className="text-muted">{icon}</span><span className="text-sm text-muted">{label}</span><span className={cn('ms-auto tabular-nums', strong ? 'font-bold' : 'font-semibold')}>{value}</span></div>
  );
  return (
    <Link to={`/agents/${a.id}`} data-testid="agent-card"
      className={cn('group flex flex-col gap-3 rounded-xl border bg-surface p-5 shadow-[0_1px_2px_rgba(16,35,30,0.04)] transition-[box-shadow,transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-brand hover:shadow-[0_8px_24px_-10px_rgba(16,35,30,0.25)]',
        a.alerts.length ? 'border-[#C8862A]' : 'border-line', !a.active && 'opacity-60')}>
      <div className="flex items-center gap-3">
        <span className="grid size-12 flex-none place-items-center rounded-full bg-brand text-lg font-bold text-white">{initials(a.fullName)}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-bold group-hover:text-brand-strong">{a.fullName}</div>
          <div className="flex items-center gap-1.5 text-sm text-muted"><Phone aria-hidden="true" className="size-3.5" /><bdi dir="ltr">{a.phone ?? 'بلا هاتف'}</bdi></div>
        </div>
        {!a.active ? <Badge>موقوف</Badge> : a.alerts.length > 0 && <Badge tone="warn">{a.alerts.length} تنبيه</Badge>}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        {figure(<Banknote aria-hidden="true" className="size-4" />, 'في ذمته نقداً', formatNumber(a.custody), true)}
        {figure(<Package aria-hidden="true" className="size-4" />, 'مواد في عهدته', a.goodsItems ? `${formatNumber(a.goods)} في ${a.goodsItems} صنف` : 'لا شيء')}
        {figure(<Boxes aria-hidden="true" className="size-4" />, 'صناديق تبرعات', String(a.boxes))}
        {figure(<Truck aria-hidden="true" className="size-4" />, 'سلّم في 30 يوماً', a.pendingDeliveries ? `${a.last30.deliveries} · بقي ${a.pendingDeliveries}` : String(a.last30.deliveries))}
        {figure(<HandCoins aria-hidden="true" className="size-4" />, 'حصّل في 30 يوماً', formatNumber(a.last30.collected + a.last30.cashDonated))}
      </div>
      {a.alerts.length > 0 && <ul className="flex flex-col gap-1 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn-ink">{a.alerts.slice(0, 3).map((t) => <li key={t} className="flex gap-1.5"><AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 flex-none" />{t}</li>)}</ul>}
      <div className="text-sm text-muted">آخر نشاط: {formatAgo(a.lastActivity)}</div>
    </Link>
  );
}

export function Agents() {
  const { user } = useAuth();
  const overview = useQuery({ queryKey: ['agents', 'overview'], queryFn: () => api<Overview>('/agents/overview') });
  const [tab, setTab] = useState<'agents' | 'donations'>('agents');
  const [adding, setAdding] = useState(false);
  if (overview.isPending) return <Skeleton className="h-64 w-full" />;
  if (overview.error) return <Alert>{overview.error.message}</Alert>;
  const { agents, totals, limits } = overview.data;

  return (
    <>
      <PageHeader title="المتعهدون" description="يد المركز في الميدان: يوزّعون، ويحصّلون الصناديق، ويتسلّمون التبرعات، ويرفعون الطلبات. وكل ما دخل أيديهم مقيَّد في ذممهم."
        action={user?.role === 'ADMIN' && <Button onClick={() => setAdding(true)}><UserPlus aria-hidden="true" className="size-4" />أضف متعهداً</Button>} />
      <section aria-label="مؤشرات المتعهدين" className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-4">
        <Tile icon={<Truck aria-hidden="true" className="size-6" />} label="متعهدون عاملون" value={totals.agents} note={`سلّموا ${formatNumber(totals.deliveries30)} عائلة في 30 يوماً`} />
        <Tile icon={<Banknote aria-hidden="true" className="size-6" />} label="نقد في ذممهم" value={totals.custody} note="دينار لم يُسلَّم للمحاسب بعد" />
        <Tile icon={<HandCoins aria-hidden="true" className="size-6" />} label="حصيلة 30 يوماً" value={totals.collected30} note="صناديق وتبرعات نقدية" />
        <Tile icon={<AlertTriangle aria-hidden="true" className="size-6" />} label="يستوجبون النظر" value={totals.withAlerts} tone="warn" note={`ذمة تجاوزت ${limits.custodyStaleDays} أيام، أو صندوق تجاوز ${limits.boxStaleDays} يوماً`} />
      </section>
      <Segmented label="العرض" value={tab} onChange={setTab} options={[['agents', `المتعهدون (${agents.length})`], ['donations', `التبرعات المسجَّلة${totals.openReports ? ` · ${totals.openReports} تنتظر` : ''}`]]} />
      {tab === 'agents' ? (
        agents.length === 0 ? <Card><p className="text-muted">لا متعهد بعد. يضيفه مدير النظام باسمه وهاتفه.</p></Card>
          : <div className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-4">{agents.map((a) => <AgentCard key={a.id} a={a} />)}</div>
      ) : (
        <Card className="flex flex-col gap-2">
          <h2 className="text-lg font-bold">تبرعات تسلّمها المتعهدون</h2>
          <p className="text-sm text-muted">النقدي دخل ذمة متعهده بسند قبض ساعةَ تسجيله، والعيني بلاغ حتى يستلمه أمين المخزن.</p>
          <AgentDonations />
        </Card>
      )}
      <AddAgent open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
