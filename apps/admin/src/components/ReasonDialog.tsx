import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Dialog, Field } from './ui';

/** دايلوغ قرار بسبب مكتوب. زر التأكيد يسمّي الفعل نفسه. */
export function ReasonDialog({ open, title, children, confirmLabel, danger, required = true, pending, error, onConfirm, onClose }: {
  open: boolean; title: string; children?: ReactNode; confirmLabel: string; danger?: boolean; required?: boolean;
  pending?: boolean; error?: string | null; onConfirm: (reason: string) => void; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  const ok = !required || reason.trim().length >= 3;
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      {children}
      {error && <Alert>{error}</Alert>}
      <Field label={required ? 'السبب (لازم)' : 'ملاحظة (اختيارية)'}>
        {(id) => (
          <textarea id={id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="اكتبه كما سيقرؤه من يراجع السجل لاحقاً"
            className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5" />
        )}
      </Field>
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>إلغاء</Button>
        <Button variant={danger ? 'danger' : 'primary'} disabled={!ok || pending} onClick={() => onConfirm(reason.trim())}>{pending ? 'جارٍ التنفيذ…' : confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
