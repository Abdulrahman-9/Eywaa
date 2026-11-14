import { useMutation } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api, tokenStore } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from './toast';
import { Alert, Badge, Button, Dialog, Field, Input } from './ui';

/** تغيير كلمة المرور. تُعرض وحدها حين تكون الكلمة مؤقتة وضعها المدير. */
export function PasswordForm({ onDone, forced }: { onDone: () => void; forced?: boolean }) {
  const toast = useToast();
  const { refresh } = useAuth();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const change = useMutation({
    mutationFn: () => api<{ token: string }>('/auth/password', { method: 'POST', body: { current: f.current, next: f.next } }),
    // التغيير يُنهي كل جلسة سبقته؛ والخادم يعيد رمزاً جديداً لهذه الجلسة وحدها.
    onSuccess: async (r) => { tokenStore.set(r.token); toast('تغيّرت كلمة المرور'); setF({ current: '', next: '', again: '' }); await refresh(); onDone(); },
  });
  const mismatch = !!f.again && f.next !== f.again;
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); change.mutate(); }} noValidate>
      {forced && <Alert tone="warn"><strong>كلمة مرورك مؤقتة وضعها المدير.</strong> ضع كلمة لا يعرفها غيرك قبل أن تتابع.</Alert>}
      {change.error && <Alert>{change.error.message}</Alert>}
      <Field label="كلمة المرور الحالية">{(id) => <Input id={id} dir="ltr" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />}</Field>
      <Field label="كلمة المرور الجديدة" hint="12 خانة على الأقل">{(id) => <Input id={id} dir="ltr" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />}</Field>
      <Field label="أعِدها للتأكد" error={mismatch ? 'الكلمتان لا تتطابقان' : undefined}>{(id) => <Input id={id} dir="ltr" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} />}</Field>
      <div className="flex justify-end"><Button type="submit" disabled={!f.current || f.next.length < 12 || f.next !== f.again || change.isPending}>غيّر كلمة المرور</Button></div>
    </form>
  );
}

export function Totp({ bare }: { bare?: boolean } = {}) {
  const toast = useToast();
  const { user, refresh } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [svg, setSvg] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [offCode, setOffCode] = useState('');
  useEffect(() => { if (setup) QRCode.toString(setup.uri, { type: 'svg', margin: 1 }).then(setSvg); }, [setup]);
  const start = useMutation({ mutationFn: () => api<{ secret: string; uri: string }>('/auth/totp/setup', { method: 'POST' }), onSuccess: setSetup });
  const enable = useMutation({
    mutationFn: () => api('/auth/totp/enable', { method: 'POST', body: { code } }),
    onSuccess: async () => { toast('فُعّل التحقق بعاملين'); setSetup(null); setCode(''); await refresh(); },
  });
  const disable = useMutation({
    mutationFn: () => api('/auth/totp/disable', { method: 'POST', body: { password, code: offCode } }),
    onSuccess: async () => { toast('عُطّل التحقق بعاملين'); setPassword(''); setOffCode(''); await refresh(); },
  });
  const error = start.error ?? enable.error ?? disable.error;

  return (
    <div className={bare ? 'flex flex-col gap-3' : 'flex flex-col gap-3 border-t border-line pt-4'}>
      <div className="flex items-center justify-between gap-3"><h3 className="font-bold">التحقق بعاملين</h3>{user?.totpEnabled ? <Badge tone="ok">مفعَّل</Badge> : <Badge tone={user?.totpRecommended ? 'warn' : 'neutral'}>غير مفعَّل</Badge>}</div>
      <p className="text-sm text-muted">عند الدخول يُطلب مع كلمة المرور رمز من تطبيق المصادقة على هاتفك، فلا تكفي الكلمة وحدها لمن سرقها.{user?.totpRecommended && !user.totpEnabled ? ' دورك يملك المال أو الصلاحيات، فتفعيله مطلوب منك.' : ''}</p>
      {error && <Alert>{error.message}</Alert>}
      {!user?.totpEnabled && !setup && <Button variant="secondary" className="self-start" disabled={start.isPending} onClick={() => start.mutate()}>ابدأ التفعيل</Button>}
      {setup && (
        <div className="flex flex-col gap-3">
          <p>امسح هذا الرمز بتطبيق المصادقة، أو أدخل السرّ باليد، ثم اكتب الرمز الذي يعرضه:</p>
          <div className="flex flex-wrap items-center gap-4">
            <div role="img" aria-label="رمز تفعيل التحقق بعاملين" className="size-36 flex-none" dangerouslySetInnerHTML={{ __html: svg }} />
            <code dir="ltr" data-testid="totp-secret" className="break-all rounded-lg bg-ground p-2 text-sm">{setup.secret}</code>
          </div>
          <Field label="الرمز من التطبيق">{(id) => <Input id={id} dir="ltr" inputMode="numeric" className="text-center text-xl tracking-[0.4em]" value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
          <Button className="self-end" disabled={code.replace(/\D/g, '').length !== 6 || enable.isPending} onClick={() => enable.mutate()}>فعّل</Button>
        </div>
      )}
      {user?.totpEnabled && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-40 flex-1"><Field label="لتعطيله: كلمة مرورك">{(id) => <Input id={id} dir="ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field></div>
          <div className="w-36"><Field label="ورمز من التطبيق">{(id) => <Input id={id} dir="ltr" inputMode="numeric" autoComplete="one-time-code" className="text-center tracking-[0.3em]" value={offCode} onChange={(e) => setOffCode(e.target.value)} />}</Field></div>
          <Button variant="danger" disabled={!password || offCode.replace(/\D/g, '').length !== 6 || disable.isPending} onClick={() => disable.mutate()}>عطّل</Button>
        </div>
      )}
    </div>
  );
}

export function AccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} title="حسابي" onClose={onClose}>
      <PasswordForm onDone={() => {}} />
      <Totp />
      <div className="flex justify-end"><Button variant="secondary" onClick={onClose}>إغلاق</Button></div>
    </Dialog>
  );
}
