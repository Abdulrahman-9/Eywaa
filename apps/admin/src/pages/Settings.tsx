import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Dialog, Field, Input, PageHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatNumber } from '../lib/format';

interface Setting {
  key: string;
  label: string;
  value: number;
  updatedAt: string;
  updatedBy: string | null;
}

export function Settings() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Setting[]>('/settings') });
  const poverty = settings.data?.find((s) => s.key === 'poverty_line_iqd');
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: (value: number) => api('/settings/poverty_line_iqd', { method: 'PUT', body: { value } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      setDraft('');
    },
    onSettled: () => setConfirming(false),
  });
  const isAdmin = user?.role === 'ADMIN';
  const next = Number(draft.replace(/[^\d]/g, ''));
  const valid = Number.isInteger(next) && next > 0 && next !== poverty?.value;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (valid) setConfirming(true);
  }

  return (
    <>
      <PageHeader title="الإعدادات" description="القيم التي يُبنى عليها الاستحقاق. كل تغيير فيها يُسجَّل باسم صاحبه." />
      {(settings.error || save.error) && <Alert>{(settings.error ?? save.error)!.message}</Alert>}
      {save.isSuccess && <Alert tone="ok">حُفظ خط الفقر الجديد، ويسري من الآن.</Alert>}
      <Card className="flex max-w-2xl flex-col gap-4">
        <div>
          <h2 className="text-lg font-bold">خط الفقر</h2>
          <p className="text-muted">دخل الفرد في الشهر بالدينار العراقي. العائلة التي دخل فردها دونه تُعدّ تحت خط الفقر.</p>
        </div>
        {!poverty ? <Skeleton className="h-10 w-48" /> : (
          <>
            <p className="text-4xl font-bold tabular-nums">{formatNumber(poverty.value)} <span className="text-lg font-medium text-muted">دينار</span></p>
            <p className="text-sm text-muted">
              {poverty.updatedBy ? `آخر تغيير: ${formatDateTime(poverty.updatedAt)} بيد ${poverty.updatedBy}` : 'القيمة الابتدائية، لم تُغيَّر بعد.'}
            </p>
          </>
        )}
        {isAdmin ? (
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <div className="min-w-48 flex-1">
              <Field label="القيمة الجديدة بالدينار">
                {(id) => <Input id={id} dir="ltr" inputMode="numeric" placeholder="300000" value={draft} onChange={(e) => setDraft(e.target.value)} />}
              </Field>
            </div>
            <Button type="submit" disabled={!valid}>تغيير</Button>
          </form>
        ) : (
          <p className="border-t border-line pt-4 text-sm text-muted">تغيير هذه القيمة من صلاحية مدير النظام وحده.</p>
        )}
      </Card>

      <Dialog open={confirming} title="تأكيد تغيير خط الفقر" onClose={() => setConfirming(false)}>
        <p>
          سيتغيّر خط الفقر من <strong>{poverty && formatNumber(poverty.value)}</strong> إلى <strong>{formatNumber(next)}</strong> ديناراً.
          يسري ذلك فوراً على تقدير حال كل العوائل.
        </p>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => setConfirming(false)}>إلغاء</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate(next)}>تأكيد التغيير</Button>
        </div>
      </Dialog>
    </>
  );
}
