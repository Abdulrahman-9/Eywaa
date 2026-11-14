import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatNumber } from '../lib/format';
import type { Fund } from './Cashbox';
import type { Program } from './Programs';

export const CAMPAIGN_STATUS = {
  DRAFT: ['مسودة', 'neutral'], PENDING_APPROVAL: ['تنتظر الاعتماد', 'warn'], ACTIVE: ['جارية', 'ok'],
  CLOSED: ['مُقفلة', 'neutral'], CANCELLED: ['ملغاة', 'danger'], REJECTED: ['مرفوضة', 'danger'],
} as const;
export type CampaignStatus = keyof typeof CAMPAIGN_STATUS;
interface Row { id: string; name: string; status: CampaignStatus; unit: string; startsOn: string; endsOn: string; program: string; families: number; delivered: number; quantity: number }
export interface Point { id: string; name: string; active: boolean }

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function NewCampaign({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api<Program[]>('/programs'), enabled: open });
  const points = useQuery({ queryKey: ['points'], queryFn: () => api<Point[]>('/points'), enabled: open });
  const [form, setForm] = useState({ name: '', programId: '', fundId: '', startsOn: today(), endsOn: inDays(7), pointIds: [] as string[] });
  const [newPoint, setNewPoint] = useState('');
  const active = programs.data?.filter((p) => p.active) ?? [];
  const program = active.find((p) => p.id === form.programId);
  const money = program?.kind === 'MONEY';
  const funds = useQuery({ queryKey: ['accounting'], queryFn: () => api<{ funds: Fund[] }>('/accounting/summary'), enabled: open && money, retry: false });
  const usable = funds.data?.funds.filter((x) => !x.programId || x.programId === form.programId) ?? [];

  const addPoint = useMutation({
    mutationFn: () => api<Point>('/points', { method: 'POST', body: { name: newPoint.trim() } }),
    onSuccess: (p) => { setNewPoint(''); setForm((f) => ({ ...f, pointIds: [...f.pointIds, p.id] })); queryClient.invalidateQueries({ queryKey: ['points'] }); },
  });
  const create = useMutation({
    mutationFn: () => api<{ id: string }>('/campaigns', { method: 'POST', body: { ...form, fundId: money ? form.fundId : undefined } }),
    onSuccess: (c) => { toast('أُنشئت مسودة الحملة'); queryClient.invalidateQueries({ queryKey: ['campaigns'] }); onClose(); navigate(`/campaigns/${c.id}`); },
  });

  return (
    <Dialog open={open} title="حملة توزيع جديدة" onClose={() => { create.reset(); onClose(); }}>
      {(create.error || addPoint.error) && <Alert>{(create.error ?? addPoint.error)!.message}</Alert>}
      <Field label="البرنامج">
        {(id) => (
          <Select id={id} value={form.programId} onChange={(e) => setForm({ ...form, programId: e.target.value })}>
            <option value="">اختر برنامجاً</option>
            {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
      </Field>
      {program && <p className="rounded-lg bg-brand-soft px-3 py-2">يستحقه الآن <strong>{formatNumber(program.eligibleFamilies)}</strong> عائلة، وحاجتها {formatNumber(program.eligibleQuantity)} {program.unit}. من استلم قريباً يُستثنى.</p>}
      {money && (
        <Field label="تُصرف من صندوق" hint="يُحجز مبلغ الحملة من المتاح فيه عند الاعتماد">
          {(id) => <Select id={id} value={form.fundId} onChange={(e) => setForm({ ...form, fundId: e.target.value })}><option value="">اختر الصندوق</option>{usable.map((x) => <option key={x.id} value={x.id}>{x.name} (المتاح {formatNumber(x.available)})</option>)}</Select>}
        </Field>
      )}
      <Field label="اسم الحملة">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="مثال: السلة الغذائية لشهر كانون الأول" />}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="تبدأ">{(id) => <Input id={id} type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} />}</Field>
        <Field label="تنتهي">{(id) => <Input id={id} type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} />}</Field>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">نقاط التوزيع (تُقسَّم العوائل عليها بالتساوي)</legend>
        <div className="flex flex-wrap gap-2">
          {points.data?.filter((p) => p.active).map((p) => (
            <label key={p.id} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-3.5">
              <input type="checkbox" className="size-[18px] accent-brand" checked={form.pointIds.includes(p.id)}
                onChange={(e) => setForm({ ...form, pointIds: e.target.checked ? [...form.pointIds, p.id] : form.pointIds.filter((x) => x !== p.id) })} />{p.name}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1"><Field label="نقطة جديدة">{(id) => <Input id={id} value={newPoint} onChange={(e) => setNewPoint(e.target.value)} />}</Field></div>
          <Button variant="secondary" disabled={newPoint.trim().length < 2 || addPoint.isPending} onClick={() => addPoint.mutate()}>أضف النقطة</Button>
        </div>
      </fieldset>
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>إلغاء</Button>
        <Button disabled={!form.programId || (money && !form.fundId) || form.name.trim().length < 3 || !form.pointIds.length || form.endsOn < form.startsOn || create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'جارٍ الإنشاء…' : 'أنشئ المسودة'}</Button>
      </div>
    </Dialog>
  );
}

export function Campaigns() {
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['campaigns'], queryFn: () => api<Row[]>('/campaigns') });
  const canManage = user?.role === 'ADMIN' || user?.role === 'DISTRIBUTION_MANAGER';
  return (
    <>
      <PageHeader title="حملات التوزيع" description="كل حملة توزّع برنامجاً على مستحقيه في مدة ونقاط معلومة."
        action={canManage && <Button onClick={() => setCreating(true)}>حملة جديدة</Button>} />
      {list.error && <Alert>{list.error.message}</Alert>}
      {list.isPending && <Skeleton className="h-24 w-full" />}
      {list.data?.length === 0 && <Card className="py-10 text-center text-muted">لا حملات بعد. أنشئ برنامجاً ثم حملة لتوزيعه.</Card>}
      <div className="flex flex-col gap-3">
        {list.data?.map((c) => (
          <Link key={c.id} to={`/campaigns/${c.id}`} className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-surface p-5 hover:border-brand">
            <div className="min-w-0 flex-[1_1_18rem]">
              <div className="flex flex-wrap items-center gap-2"><strong className="text-lg">{c.name}</strong><Badge tone={CAMPAIGN_STATUS[c.status][1]}>{CAMPAIGN_STATUS[c.status][0]}</Badge></div>
              <span className="text-sm text-muted">{c.program} · من {formatDate(c.startsOn)} إلى {formatDate(c.endsOn)}</span>
            </div>
            <div className="min-w-48 flex-1">
              <div className="mb-1 flex justify-between text-sm"><span>سُلِّم {formatNumber(c.delivered)} من {formatNumber(c.families)}</span><span>{c.families ? Math.round((c.delivered / c.families) * 100) : 0}%</span></div>
              <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-line"><div className="h-2 bg-brand" style={{ width: `${c.families ? (c.delivered / c.families) * 100 : 0}%` }} /></div>
            </div>
          </Link>
        ))}
      </div>
      <NewCampaign open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
