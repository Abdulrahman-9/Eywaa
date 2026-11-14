import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { DOC_TYPES, type DocType } from '../lib/labels';
import { Alert, Field, Input, Select } from './ui';

export interface DocDraft { type: DocType; number: string; register?: string; page?: string; portfolio?: string }

/** الوثيقة مكتملة الحقول اللازمة لنوعها. */
export function isDocComplete(d: DocDraft): boolean {
  const digits = d.number.replace(/\D/g, '');
  if (d.type === 'NATIONAL_CARD') return digits.length === 12;
  if (d.type === 'CIVIL_ID') return !!d.number.trim() && !!d.register?.trim() && !!d.page?.trim();
  return !!d.number.trim() && !!d.portfolio?.trim();
}

interface Lookup { found: boolean; familyId?: string; familyNo?: string; personName?: string }

/** حقول وثيقة الهوية، مع فحص التكرار فور اكتمالها. */
export function DocumentFields({ value, onChange, onDuplicate, idPrefix }: {
  value: DocDraft; onChange: (d: DocDraft) => void; onDuplicate?: (dup: boolean) => void; idPrefix: string;
}) {
  const [hit, setHit] = useState<Lookup | null>(null);
  const complete = isDocComplete(value);
  const key = JSON.stringify(value);

  useEffect(() => {
    setHit(null);
    onDuplicate?.(false);
    if (!complete) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api<Lookup>('/families/lookup/document', { method: 'POST', body: value })
        .then((r) => { if (!cancelled) { setHit(r); onDuplicate?.(r.found); } })
        .catch(() => {});
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = (patch: Partial<DocDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
        <Field label="نوع الوثيقة">
          {(id) => (
            <Select id={id} value={value.type} onChange={(e) => onChange({ type: e.target.value as DocType, number: '' })}>
              {Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          )}
        </Field>
        <Field label={value.type === 'NATIONAL_CARD' ? 'رقم البطاقة (12 خانة)' : 'الرقم'}>
          {(id) => <Input id={id} name={`${idPrefix}-number`} dir="ltr" inputMode="numeric" className={hit?.found ? 'border-2 !border-danger' : ''} value={value.number} onChange={(e) => set({ number: e.target.value })} />}
        </Field>
        {value.type === 'CIVIL_ID' && (
          <>
            <Field label="السجل">{(id) => <Input id={id} dir="ltr" value={value.register ?? ''} onChange={(e) => set({ register: e.target.value })} />}</Field>
            <Field label="الصفحة">{(id) => <Input id={id} dir="ltr" value={value.page ?? ''} onChange={(e) => set({ page: e.target.value })} />}</Field>
          </>
        )}
        {value.type === 'NATIONALITY_CERT' && (
          <Field label="رقم المحفظة">{(id) => <Input id={id} dir="ltr" value={value.portfolio ?? ''} onChange={(e) => set({ portfolio: e.target.value })} />}</Field>
        )}
      </div>
      {hit?.found && (
        <Alert>
          <strong>هذه الوثيقة مسجَّلة سلفاً.</strong> هي للعائلة {hit.familyNo} باسم «{hit.personName}». لا يُسجَّل الشخص مرتين.{' '}
          <Link to={`/families/${hit.familyId}`} className="font-bold underline">افتح السجل القائم</Link>
        </Alert>
      )}
      {hit && !hit.found && <p className="text-sm font-medium text-brand-strong">الوثيقة غير مسجَّلة من قبل.</p>}
    </div>
  );
}
