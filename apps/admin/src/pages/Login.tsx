import { useState, type FormEvent } from 'react';
import { AidMotif } from '../components/AidMotif';
import { Alert, Button, Field, Input } from '../components/ui';
import { useAuth } from '../lib/auth';

export function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر الدخول');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-wrap">
      <div className="flex flex-[1_1_24rem] flex-col justify-center gap-6 bg-brand-soft px-8 py-12">
        <AidMotif className="h-auto w-full max-w-md" />
        <p className="max-w-md text-2xl font-bold leading-loose text-brand-strong">﴿ أَوْ إِطْعَامٌ فِي يَوْمٍ ذِي مَسْغَبَةٍ ﴾</p>
        <p className="max-w-md text-muted">نظام يحفظ لكل عائلة حقها: يصل كاملاً، مرة واحدة، وعليه شاهد.</p>
      </div>
      <div className="flex flex-[1_1_24rem] items-center justify-center px-6 py-12">
        <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5" noValidate>
          <div>
            <h1 className="text-2xl font-bold">إيواء</h1>
            <p className="text-muted">سجّل دخولك لإدارة المركز الإغاثي</p>
          </div>
          {error && <Alert>{error}</Alert>}
          <Field label="اسم المستخدم">
            {(id) => <Input id={id} dir="ltr" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />}
          </Field>
          <Field label="كلمة المرور">
            {(id) => <Input id={id} dir="ltr" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Button type="submit" disabled={busy || !username || !password}>{busy ? 'جارٍ الدخول…' : 'دخول'}</Button>
        </form>
      </div>
    </div>
  );
}
