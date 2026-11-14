import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatNumber, digits } from '../lib/format';
import { ReasonDialog } from './ReasonDialog';
import { useToast } from './toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Select } from './ui';

interface Case { id: string; headName: string; phone: string | null; mahalla: string | null; quantity: number; deliveredAt: string; warnings: string[]; by: string; quickNo: number; quickStatus: string }
interface Grant {
  id: string; agentId: string; agentName: string; unit: string; maxCases: number; perCase: number; used: number; remaining: number; expiresAt: string; reason: string;
  createdBy: string; createdAt: string; state: 'ACTIVE' | 'EXPIRED' | 'REVOKED'; revokedBy: string | null; revokeNote: string | null; cases: Case[];
}
const STATE = { ACTIVE: ['سارٍ', 'warn'], EXPIRED: ['انتهى', 'neutral'], REVOKED: ['سُحب', 'neutral'] } as const;
const MANAGERS = ['ADMIN', 'DISTRIBUTION_MANAGER'];
export const GRANT_READERS = [...MANAGERS, 'BENEFICIARY_SUPERVISOR', 'AUDITOR'];

/**
 * التخويل الاستثنائي: إذن لمتعهد بالصرف لغير المسجَّلين، بسقف ومدة وسبب.
 * كل حالة تظهر هنا باسمها وما لفت النظر فيها، وتصير طلب تسجيل سريع.
 */
export function Grants({ campaignId, active, agents }: { campaignId: string; active: boolean; agents: { id: string; name: string }[] }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ agentId: '', maxCases: '10', perCase: '1', hours: '6', reason: '' });
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const canManage = !!user && MANAGERS.includes(user.role);
  const list = useQuery({ queryKey: ['campaign', campaignId, 'grants'], queryFn: () => api<Grant[]>(`/campaigns/${campaignId}/grants`), refetchInterval: active ? 30_000 : false });
  const refresh = () => qc.invalidateQueries({ queryKey: ['campaign', campaignId, 'grants'] });
  const create = useMutation({
    mutationFn: () => api(`/campaigns/${campaignId}/grants`, { method: 'POST', body: { agentId: form.agentId, maxCases: Number(form.maxCases), perCase: Number(form.perCase), hours: Number(form.hours), reason: form.reason.trim() } }),
    onSuccess: () => { toast('صدر التخويل. يصل هاتف المتعهد عند مزامنته.'); setCreating(false); refresh(); },
  });
  const revoke = useMutation({
    mutationFn: (note: string) => api(`/grants/${revoking!.id}/revoke`, { method: 'POST', body: { note } }),
    onSuccess: () => { toast('سُحب التخويل'); setRevoking(null); refresh(); },
  });
  const grants = list.data ?? [];
  if (!grants.length && !(active && canManage && agents.length)) return null;
  const ok = !!form.agentId && Number(form.maxCases) > 0 && Number(form.perCase) > 0 && Number(form.hours) > 0 && form.reason.trim().length >= 5;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold">الصرف لغير المسجَّلين بتخويل</h2>
          <p className="text-sm text-muted">حين يتأخر الوقت والطعام لا يحتمل: إذن لمتعهد بعينه، بسقف ومدة. كل حالة باسمها، وتصير طلب تسجيل.</p>
        </div>
        {active && canManage && agents.length > 0 && <Button variant="secondary" onClick={() => { setForm({ agentId: agents[0].id, maxCases: '10', perCase: '1', hours: '6', reason: '' }); create.reset(); setCreating(true); }}>خوّل متعهداً</Button>}
      </div>
      {list.error && <Alert>{list.error.message}</Alert>}
      {grants.map((g) => (
        <div key={g.id} data-grant={g.agentName} className="flex flex-col gap-2 rounded-lg border border-line px-4 py-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2"><strong>{g.agentName}</strong><Badge tone={STATE[g.state][1]}>{STATE[g.state][0]}</Badge><span className="tabular-nums">صُرف {g.used} من {g.maxCases} · {g.perCase} {g.unit} للحالة</span></div>
              <span><span className="text-muted">السبب: </span>{g.reason}</span>
              <span className="text-sm text-muted">خوّله <bdi>{g.createdBy}</bdi> · <bdi>{formatDateTime(g.createdAt)}</bdi> · {g.state === 'ACTIVE' ? 'ينتهي' : 'انتهى'} <bdi>{formatDateTime(g.expiresAt)}</bdi>{g.revokedBy && ` · سحبه ${g.revokedBy}: ${g.revokeNote}`}</span>
            </div>
            {g.state === 'ACTIVE' && canManage && <Button variant="danger" onClick={() => { revoke.reset(); setRevoking(g); }}>اسحب التخويل</Button>}
          </div>
          {g.cases.length > 0 && (
            <ul className="flex flex-col">
              {g.cases.map((c) => (
                <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 border-t border-line py-2">
                  <strong>{c.headName}</strong>
                  <span className="text-sm text-muted">{[c.phone, c.mahalla].filter(Boolean).join(' · ')}{(c.phone || c.mahalla) && ' · '}{formatNumber(c.quantity)} {g.unit} · <bdi>{formatDateTime(c.deliveredAt)}</bdi></span>
                  <Link to="/requests" className="text-sm font-semibold text-brand-strong underline">طلب {c.quickNo}{c.quickStatus === 'COMPLETED' ? ' (استُكمل)' : ''}</Link>
                  {c.warnings.map((w) => <span key={w} className="w-full text-sm font-semibold text-danger">{w}</span>)}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <Dialog open={creating} title="تخويل متعهد بالصرف لغير المسجَّلين" onClose={() => setCreating(false)}>
        <Alert tone="warn">هذا صرف بلا رمز. يُسجَّل باسمك وسببك، ويُراجَع كل اسم صُرف له.</Alert>
        {create.error && <Alert>{create.error.message}</Alert>}
        <Field label="المتعهد">{(id) => <Select id={id} value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
          <Field label="أقصى عدد الحالات">{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={form.maxCases} onChange={(e) => setForm({ ...form, maxCases: digits(e.target.value) })} />}</Field>
          <Field label="المقدار لكل حالة">{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={form.perCase} onChange={(e) => setForm({ ...form, perCase: digits(e.target.value) })} />}</Field>
          <Field label="يسري (ساعة)">{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={form.hours} onChange={(e) => setForm({ ...form, hours: digits(e.target.value) })} />}</Field>
        </div>
        <Field label="سبب التخويل">{(id) => <Input id={id} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="مثال: تأخر الوقت وبقي لحم لا يحتمل إلى الغد" />}</Field>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setCreating(false)}>إلغاء</Button>
          <Button disabled={!ok || create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'جارٍ الإصدار…' : 'أصدر التخويل'}</Button>
        </div>
      </Dialog>
      <ReasonDialog open={!!revoking} title={`سحب تخويل ${revoking?.agentName ?? ''}`} confirmLabel="اسحب التخويل" danger pending={revoke.isPending} error={revoke.error?.message}
        onClose={() => setRevoking(null)} onConfirm={(note) => revoke.mutate(note)}>
        <p>لا يُصرف به بعد الآن. وما صُرف والهاتف منقطع قبل السحب يُرفع ويُنبَّه عليه.</p>
      </ReasonDialog>
    </Card>
  );
}
