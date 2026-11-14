import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ReasonDialog } from '../components/ReasonDialog';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { ROLES, ROLE_LABEL, type Role } from '../lib/roles';

interface UserRow {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  active: boolean;
  createdAt: string;
  totpEnabled: boolean;
  locked: boolean;
}

function fieldErrors(err: unknown): Record<string, string> {
  const details = err instanceof ApiError ? (err.details as { errors?: { path: string; message: string }[] }) : null;
  return Object.fromEntries((details?.errors ?? []).map((e) => [e.path, e.message]));
}

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ fullName: '', username: '', password: '', role: 'FIELD_RESEARCHER' as Role });
  const create = useMutation({
    mutationFn: () => api('/users', { method: 'POST', body: form }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setForm({ fullName: '', username: '', password: '', role: 'FIELD_RESEARCHER' });
      onClose();
    },
  });
  const errors = fieldErrors(create.error);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <Dialog open={open} title="إضافة مستخدم" onClose={() => { create.reset(); onClose(); }}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {create.error && Object.keys(errors).length === 0 && <Alert>{create.error.message}</Alert>}
        <Field label="الاسم الكامل" error={errors.fullName}>
          {(id) => <Input id={id} value={form.fullName} onChange={set('fullName')} required />}
        </Field>
        <Field label="اسم المستخدم" error={errors.username} hint="حروف لاتينية صغيرة وأرقام، مثل: ahmed.ali">
          {(id) => <Input id={id} dir="ltr" autoComplete="off" value={form.username} onChange={set('username')} required />}
        </Field>
        <Field label="كلمة المرور" error={errors.password} hint="12 خانة على الأقل">
          {(id) => <Input id={id} dir="ltr" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required />}
        </Field>
        <Field label="الدور" error={errors.role}>
          {(id) => (
            <Select id={id} value={form.role} onChange={set('role')}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </Select>
          )}
        </Field>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => { create.reset(); onClose(); }}>إلغاء</Button>
          <Button type="submit" disabled={create.isPending}>{create.isPending ? 'جارٍ الحفظ…' : 'إضافة'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

interface Device { id: string; label: string; registeredAt: string; lastSeenAt: string; revokedAt: string | null; revokeNote: string | null; revokedBy: string | null; username: string; fullName: string }

/** هواتف الميدان المسجَّلة. سحب الجهاز يرفض طلباته ويمحو ما عليه حين يتصل. */
function Devices() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<Device | null>(null);
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<Device[]>('/devices') });
  const revoke = useMutation({
    mutationFn: (note: string) => api(`/devices/${revoking!.id}/revoke`, { method: 'POST', body: { note } }),
    onSuccess: () => { toast('سُحب الجهاز'); setRevoking(null); queryClient.invalidateQueries({ queryKey: ['devices'] }); },
  });
  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-bold">أجهزة الميدان</h2>
        <p className="text-sm text-muted">كل هاتف نُصّب عليه تطبيق الميدان. إن ضاع هاتف فاسحبه: تُرفض طلباته، ويمحو التطبيق ما عليه حين يتصل.</p>
      </div>
      {devices.error && <Alert>{devices.error.message}</Alert>}
      {devices.data?.length === 0 && <p className="text-muted">لم يُنصَّب التطبيق على هاتف بعد.</p>}
      {devices.data?.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-4 py-3">
          <div className="flex min-w-0 flex-[1_1_18rem] flex-col">
            <div className="flex flex-wrap items-center gap-2"><strong>{d.fullName}</strong><span dir="ltr" className="text-sm text-muted">{d.username}</span>{d.revokedAt && <Badge tone="danger">مسحوب</Badge>}</div>
            <span dir="ltr" className="truncate text-end text-sm text-muted">{d.label}</span>
            <span className="text-sm text-muted">{d.revokedAt ? `سحبه ${d.revokedBy} · ${formatDateTime(d.revokedAt)} · ${d.revokeNote}` : `آخر ظهور ${formatDateTime(d.lastSeenAt)}`}</span>
          </div>
          {!d.revokedAt && <Button variant="danger" onClick={() => setRevoking(d)}>اسحب الجهاز</Button>}
        </div>
      ))}
      <ReasonDialog open={!!revoking} title={`سحب جهاز ${revoking?.fullName ?? ''}`} confirmLabel="اسحب الجهاز" danger pending={revoke.isPending} error={revoke.error?.message}
        onClose={() => { revoke.reset(); setRevoking(null); }} onConfirm={(note) => revoke.mutate(note)}>
        <p>يُمحى ما على الهاتف حين يتصل، <strong>ومنه ما لم يُرفع من تسليمات وتسجيلات</strong>. والهاتف الذي لا يتصل لا يبلغه السحب؛ فإن كان بيد من لا يؤتمن فعطّل حساب صاحبه أيضاً.</p>
      </ReasonDialog>
    </Card>
  );
}

export function Users() {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<UserRow | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [temp, setTemp] = useState('');
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/users') });
  const update = useMutation({
    mutationFn: (v: { id: string; body: { active?: boolean; role?: Role; password?: string; resetAccess?: true } }) => api(`/users/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
    onSettled: () => { setConfirm(null); setResetting(null); setTemp(''); },
  });

  return (
    <>
      <PageHeader
        title="المستخدمون"
        description="حسابات الموظفين وأدوارهم. تعطيل الحساب يسري فوراً ولو كان صاحبه داخلاً."
        action={<Button onClick={() => setCreating(true)}>إضافة مستخدم</Button>}
      />
      {(users.error || update.error) && <Alert>{(users.error ?? update.error)!.message}</Alert>}
      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse">
            <thead>
              <tr className="text-start text-sm text-muted">
                {['الاسم', 'اسم المستخدم', 'الدور', 'الحال', 'أُنشئ في', ''].map((h, i) => (
                  <th key={i} scope="col" className="border-b border-line px-4 py-3 text-start font-medium">{h || <span className="sr-only">إجراء</span>}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.isPending && [0, 1, 2].map((i) => (
                <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton /></td></tr>
              ))}
              {users.data?.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-semibold">{u.fullName}</td>
                  <td className="px-4 py-3" dir="ltr" style={{ textAlign: 'right' }}>{u.username}</td>
                  <td className="px-4 py-3">
                    {u.id === me?.id ? ROLE_LABEL[u.role] : (
                      <Select
                        aria-label={`دور ${u.fullName}`}
                        className="max-w-48"
                        value={u.role}
                        disabled={update.isPending}
                        onChange={(e) => update.mutate({ id: u.id, body: { role: e.target.value as Role } })}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </Select>
                    )}
                  </td>
                  <td className="px-4 py-3"><div className="flex flex-wrap gap-1.5">{u.active ? <Badge tone="ok">فعّال</Badge> : <Badge tone="danger">معطَّل</Badge>}{u.locked && <Badge tone="warn">مقفل</Badge>}{u.totpEnabled && <Badge tone="info">بعاملين</Badge>}</div></td>
                  <td className="px-4 py-3 text-muted">{formatDateTime(u.createdAt)}</td>
                  <td className="px-4 py-2 text-end">
                    {u.id === me?.id ? <span className="text-sm text-muted">حسابك</span> : (
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="secondary" onClick={() => setResetting(u)}>كلمة المرور والدخول</Button>
                        {u.active ? <Button variant="danger" onClick={() => setConfirm(u)}>تعطيل</Button>
                          : <Button variant="secondary" onClick={() => update.mutate({ id: u.id, body: { active: true } })}>تفعيل</Button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
      <Devices />
      <Dialog open={!!resetting} title={`كلمة المرور والدخول: ${resetting?.fullName ?? ''}`} onClose={() => { setResetting(null); setTemp(''); }}>
        <Field label="كلمة مرور مؤقتة" hint="12 خانة على الأقل. يُلزم صاحبها بتغييرها عند أول دخول.">
          {(id) => <Input id={id} dir="ltr" autoComplete="off" value={temp} onChange={(e) => setTemp(e.target.value)} />}
        </Field>
        <div className="flex justify-end"><Button disabled={temp.length < 12 || update.isPending} onClick={() => resetting && update.mutate({ id: resetting.id, body: { password: temp } })}>ضع الكلمة المؤقتة</Button></div>
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <p>لمن أُقفل حسابه أو فقد هاتف المصادقة: يُفكّ القفل ويُعطَّل التحقق بعاملين، فيدخل بكلمة مروره ثم يفعّله من جديد.</p>
          <Button variant="danger" className="self-start" disabled={update.isPending} onClick={() => resetting && update.mutate({ id: resetting.id, body: { resetAccess: true } })}>فكّ القفل وعطّل العاملين</Button>
        </div>
      </Dialog>
      <Dialog open={!!confirm} title="تعطيل الحساب" onClose={() => setConfirm(null)}>
        <p>سيُمنع <strong>{confirm?.fullName}</strong> من الدخول فوراً، وتُقطع جلسته إن كان داخلاً. ولا يُحذف شيء مما عمله.</p>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setConfirm(null)}>إلغاء</Button>
          <Button variant="danger" disabled={update.isPending} onClick={() => confirm && update.mutate({ id: confirm.id, body: { active: false } })}>تعطيل الحساب</Button>
        </div>
      </Dialog>
    </>
  );
}
