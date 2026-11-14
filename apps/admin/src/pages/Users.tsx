import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
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

export function Users() {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<UserRow | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/users') });
  const update = useMutation({
    mutationFn: (v: { id: string; body: { active?: boolean; role?: Role } }) => api(`/users/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
    onSettled: () => setConfirm(null),
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
                  <td className="px-4 py-3">{u.active ? <Badge tone="ok">فعّال</Badge> : <Badge tone="danger">معطَّل</Badge>}</td>
                  <td className="px-4 py-3 text-muted">{formatDateTime(u.createdAt)}</td>
                  <td className="px-4 py-2 text-end">
                    {u.id === me?.id ? <span className="text-sm text-muted">حسابك</span>
                      : u.active ? <Button variant="danger" onClick={() => setConfirm(u)}>تعطيل</Button>
                      : <Button variant="secondary" onClick={() => update.mutate({ id: u.id, body: { active: true } })}>تفعيل</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
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
