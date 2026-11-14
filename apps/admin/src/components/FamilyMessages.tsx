import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { useToast } from './toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input } from './ui';

interface Message { id: string; channel: string | null; status: string; text: string; sentAt: string; title: string; kind: string }
interface Preview { recipients: number; byChannel: Record<string, number>; sample: string | null; smsParts: number; driver: { name: string; live: boolean } }

const CHANNEL: Record<string, string> = { WHATSAPP: 'واتساب', SMS: 'رسالة نصية', VOICE: 'مكالمة', NO_PHONE: 'بلا هاتف' };
const STATUS: Record<string, [string, 'ok' | 'warn' | 'danger' | 'info' | 'neutral']> = {
  QUEUED: ['في الطابور', 'warn'], SENT: ['خرجت', 'ok'], DELIVERED: ['بلغت الهاتف', 'ok'], READ: ['قُرئت', 'ok'], FAILED: ['أخفقت', 'danger'], NO_PHONE: ['بلا هاتف', 'neutral'],
};
const SENDERS = ['ADMIN', 'DISTRIBUTION_MANAGER', 'BENEFICIARY_SUPERVISOR'];
export const MESSAGE_READERS = [...SENDERS, 'AUDITOR'];

/** رسائل العائلة: ما أُرسل إليها، وزرّ لتنبيهها وحدها. */
export function FamilyMessages({ familyId, familyNo, hasPhone }: { familyId: string; familyNo: string; hasPhone: boolean }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [debounced, setDebounced] = useState('');
  const list = useQuery({ queryKey: ['family', familyId, 'messages'], queryFn: () => api<Message[]>(`/families/${familyId}/messages`) });
  useEffect(() => { const t = setTimeout(() => setDebounced(body.trim()), 400); return () => clearTimeout(t); }, [body]);
  const payload = (text: string) => ({ title: title.trim() || 'تنبيه فردي', body: text, audience: { familyId } });
  const preview = useQuery({
    queryKey: ['family', familyId, 'message-preview', debounced],
    queryFn: () => api<Preview>('/notifications/preview', { method: 'POST', body: payload(debounced) }),
    enabled: open && debounced.length >= 5, retry: false,
  });
  const send = useMutation({
    mutationFn: () => api('/notifications', { method: 'POST', body: payload(body.trim()) }),
    onSuccess: () => { toast(preview.data?.driver.live ? 'أُرسل التنبيه' : 'سُجّل التنبيه (المزوّد محاكاة: لا يصل إلى الهاتف)'); setOpen(false); qc.invalidateQueries({ queryKey: ['family', familyId, 'messages'] }); },
  });
  const rows = list.data ?? [];
  const channel = preview.data ? Object.entries(preview.data.byChannel).find(([, n]) => n > 0)?.[0] : undefined;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 flex-1 text-lg font-bold">الرسائل</h2>
        {user && SENDERS.includes(user.role) && <Button variant="secondary" disabled={!hasPhone} onClick={() => { setTitle(''); setBody(''); send.reset(); setOpen(true); }}>نبّه هذه العائلة</Button>}
      </div>
      {!hasPhone && <p className="text-sm text-warn-ink">لا رقم هاتف لهذه العائلة: لا تصلها رسالة.</p>}
      {list.error && <Alert>{list.error.message}</Alert>}
      {list.isSuccess && rows.length === 0 && <p className="text-muted">لم يُرسل إلى هذه العائلة شيء.</p>}
      <ul className="flex flex-col">
        {rows.slice(0, 6).map((m) => (
          <li key={m.id} className="flex flex-col gap-0.5 border-b border-line py-2 last:border-0">
            <div className="flex flex-wrap items-center gap-2">
              <strong>{m.title}</strong>
              <Badge tone={STATUS[m.status]?.[1] ?? 'neutral'}>{STATUS[m.status]?.[0] ?? m.status}</Badge>
              <span className="text-sm text-muted">{m.channel && `${CHANNEL[m.channel]} · `}<bdi>{formatDateTime(m.sentAt)}</bdi></span>
            </div>
            <span className="text-sm">{m.text}</span>
          </li>
        ))}
      </ul>
      {rows.length > 6 && <p className="text-sm text-muted">و{rows.length - 6} رسالة أقدم.</p>}

      <Dialog open={open} title={`تنبيه العائلة ${familyNo}`} onClose={() => setOpen(false)}>
        {(send.error || preview.error) && <Alert>{(send.error ?? preview.error)!.message}</Alert>}
        <Field label="العنوان (لا يصل العائلة؛ للسجل)">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثال: استدعاء لاستكمال وثيقة" />}</Field>
        <Field label="نص الرسالة" hint="{الاسم} و{رقم_العائلة} يُملآن وحدهما.">
          {(id) => <textarea id={id} rows={4} value={body} onChange={(e) => setBody(e.target.value)} className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5" placeholder="السلام عليكم {الاسم}. نرجو مراجعة المركز يوم الأحد ومعكم البطاقة التموينية." />}
        </Field>
        {preview.data?.sample && (
          <div className="rounded-lg bg-ground px-4 py-3">
            <div className="text-sm text-muted">كما تصل{channel && ` (${CHANNEL[channel]}${channel === 'SMS' && preview.data.smsParts > 1 ? `، ${preview.data.smsParts} رسائل` : ''})`}:</div>
            <p>{preview.data.sample}</p>
          </div>
        )}
        {preview.data && !preview.data.driver.live && <Alert tone="warn">المزوّد محاكاة: تُسجَّل الرسالة ولا تصل إلى الهاتف حتى يُربط مزوّد حقيقي.</Alert>}
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setOpen(false)}>إلغاء</Button>
          <Button disabled={body.trim().length < 5 || !preview.data || send.isPending} onClick={() => send.mutate()}>{send.isPending ? 'جارٍ الإرسال…' : 'أرسل'}</Button>
        </div>
      </Dialog>
    </Card>
  );
}
