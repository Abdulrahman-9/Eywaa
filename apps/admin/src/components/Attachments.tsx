import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, upload } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import { ATTACHMENT_CATEGORIES, type AttachmentCategory } from '../lib/labels';
import type { Attachment } from '../lib/types';
import { useToast } from './toast';
import { Alert, Button, Field, Select, Skeleton } from './ui';

/** رفع المرفقات الاختيارية وعرضها: صور و PDF، من ملف أو من الكاميرا. */
export function Attachments({ familyId, canUpload, canDelete }: { familyId: string; canUpload: boolean; canDelete: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<AttachmentCategory>('IDENTITY');
  const list = useQuery({ queryKey: ['attachments', familyId], queryFn: () => api<Attachment[]>(`/families/${familyId}/attachments`) });

  const send = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set('category', category);
      form.set('file', file);
      return upload(`/families/${familyId}/attachments`, form);
    },
    onSuccess: () => { toast('رُفع المرفق'); queryClient.invalidateQueries({ queryKey: ['attachments', familyId] }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/attachments/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('حُذف المرفق'); queryClient.invalidateQueries({ queryKey: ['attachments', familyId] }); },
    onError: (e) => toast(e.message, 'error'),
  });
  const open = useMutation({
    mutationFn: (id: string) => api<{ url: string }>(`/attachments/${id}/link`, { method: 'POST' }),
    onSuccess: (r) => window.open(r.url, '_blank', 'noopener'),
    onError: (e) => toast(e.message, 'error'),
  });

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) send.mutate(file);
  };

  return (
    <div className="flex flex-col gap-3">
      {canUpload && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-line-strong p-4">
          <div className="min-w-44 flex-1">
            <Field label="نوع المرفق">
              {(id) => (
                <Select id={id} value={category} onChange={(e) => setCategory(e.target.value as AttachmentCategory)}>
                  {Object.entries(ATTACHMENT_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" className="sr-only" aria-label="اختر ملفاً" onChange={pick} />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="التقط صورة" onChange={pick} />
          <Button variant="secondary" disabled={send.isPending} onClick={() => cameraRef.current?.click()}>التقط بالكاميرا</Button>
          <Button variant="secondary" disabled={send.isPending} onClick={() => fileRef.current?.click()}>{send.isPending ? 'جارٍ الرفع…' : 'ارفع ملفاً'}</Button>
          <p className="basis-full text-sm text-muted">اختياري. صورة أو PDF حتى 10 ميغابايت. يُخزَّن مشفّراً.</p>
        </div>
      )}
      {send.error && <Alert>{send.error.message}</Alert>}
      {list.isPending && <Skeleton />}
      {list.data?.length === 0 && <p className="text-muted">لا مرفقات.</p>}
      <ul className="flex flex-col">
        {list.data?.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-3 border-b border-line py-2.5 last:border-0">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{ATTACHMENT_CATEGORIES[a.category]}</div>
              <div className="truncate text-sm text-muted">{a.originalName} · {formatBytes(a.sizeBytes)} · {a.uploadedBy} · {formatDateTime(a.createdAt)}</div>
            </div>
            <Button variant="secondary" disabled={open.isPending} onClick={() => open.mutate(a.id)}>عرض</Button>
            {canDelete && <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(a.id)}>حذف</Button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
