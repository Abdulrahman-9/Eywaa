import { useMutation, useQueryClient } from '@tanstack/react-query';
import { digits } from '../lib/format';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { CHANGE_TYPES, HOUSING, INCOME_KINDS, RELATIONS, type ChangeType, type Housing, type IncomeKind, type Relation } from '../lib/labels';
import type { Family } from '../lib/types';
import { DocumentFields, isDocComplete, type DocDraft } from './DocumentFields';
import { useToast } from './toast';
import { Alert, Button, Dialog, Field, Input, Select } from './ui';

const TYPES: ChangeType[] = ['UPDATE_FAMILY', 'SET_INCOMES', 'UPDATE_MEMBER', 'ADD_MEMBER', 'ADD_DOCUMENT', 'CHANGE_HEAD', 'TRANSFER_MEMBER'];
const NON_HEAD = Object.entries(RELATIONS).filter(([k]) => k !== 'HEAD');

/** طلب تعديل على عائلة مسجَّلة. لا يسري حتى يعتمده موظف آخر. */
export function ChangeDialog({ family, open, onClose }: { family: Family; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<ChangeType>('UPDATE_FAMILY');
  const [reason, setReason] = useState('');
  const [contact, setContact] = useState({ phone1: '', mahalla: '', landmark: '', housing: '' as Housing | '' });
  const [incomes, setIncomes] = useState<{ kind: IncomeKind; amount: string }[]>([]);
  const [personId, setPersonId] = useState('');
  const [member, setMember] = useState({ deceased: false, isOrphan: false, disability: '', chronicIllness: '' });
  const [added, setAdded] = useState({ fullName: '', relation: 'SON' as Relation, gender: 'M' as 'M' | 'F', birthDate: '' });
  const [doc, setDoc] = useState<DocDraft>({ type: 'NATIONAL_CARD', number: '' });
  const [docDup, setDocDup] = useState(false);
  const [headChange, setHeadChange] = useState({ newHeadId: '', formerHeadRelation: 'OTHER' as Relation });
  const [transfer, setTransfer] = useState({ personId: '', toFamilyNo: '', relation: 'SPOUSE' as Relation });
  const living = family.members.filter((m) => m.status === 'ACTIVE');
  const others = family.members.filter((m) => m.relation !== 'HEAD');
  const candidates = others.filter((m) => m.status === 'ACTIVE');

  useEffect(() => {
    if (!open) return;
    setType('UPDATE_FAMILY');
    setReason('');
    setContact({ phone1: family.phone1 ?? '', mahalla: family.address.mahalla ?? '', landmark: family.address.landmark ?? '', housing: family.housing ?? '' });
    setIncomes(family.incomes.map((i) => ({ kind: i.kind, amount: String(i.amountIqd) })));
    setPersonId(living[0]?.id ?? '');
    setAdded({ fullName: '', relation: 'SON', gender: 'M', birthDate: '' });
    setDoc({ type: 'NATIONAL_CARD', number: '' });
    setHeadChange({ newHeadId: candidates[0]?.id ?? '', formerHeadRelation: 'OTHER' });
    setTransfer({ personId: others[0]?.id ?? '', toFamilyNo: '', relation: 'SPOUSE' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, family.id]);

  useEffect(() => {
    const p = family.members.find((m) => m.id === personId);
    if (p) setMember({ deceased: p.status === 'DECEASED', isOrphan: p.isOrphan, disability: p.disability ?? '', chronicIllness: p.chronicIllness ?? '' });
  }, [personId, family.members]);

  function payload(): Record<string, unknown> | null {
    switch (type) {
      case 'UPDATE_FAMILY': {
        const p: Record<string, unknown> = {};
        if (contact.phone1.trim() !== (family.phone1 ?? '')) p.phone1 = contact.phone1.trim() || null;
        if (contact.mahalla.trim() !== (family.address.mahalla ?? '')) p.mahalla = contact.mahalla.trim() || null;
        if (contact.landmark.trim() !== (family.address.landmark ?? '')) p.landmark = contact.landmark.trim() || null;
        if (contact.housing && contact.housing !== family.housing) p.housing = contact.housing;
        return Object.keys(p).length ? p : null;
      }
      case 'SET_INCOMES':
        return { incomes: incomes.filter((i) => i.amount.trim()).map((i) => ({ kind: i.kind, amountIqd: Number(digits(i.amount)) })) };
      case 'UPDATE_MEMBER':
        return personId ? {
          personId, status: member.deceased ? 'DECEASED' : 'ACTIVE', isOrphan: member.isOrphan,
          disability: member.disability.trim() || null, chronicIllness: member.chronicIllness.trim() || null,
        } : null;
      case 'ADD_MEMBER':
        return added.fullName.trim() ? { member: { ...added, fullName: added.fullName.trim(), birthDate: added.birthDate || undefined, documents: [] } } : null;
      case 'ADD_DOCUMENT':
        return personId && isDocComplete(doc) && !docDup ? { personId, document: doc } : null;
      case 'CHANGE_HEAD':
        return headChange.newHeadId ? headChange : null;
      case 'TRANSFER_MEMBER':
        return transfer.personId && /^\d{5,12}$/.test(transfer.toFamilyNo.trim()) && transfer.toFamilyNo.trim() !== family.familyNo
          ? { ...transfer, toFamilyNo: transfer.toFamilyNo.trim() } : null;
      default:
        return null;
    }
  }

  const body = payload();
  const send = useMutation({
    mutationFn: () => api(`/families/${family.id}/changes`, { method: 'POST', body: { type, payload: body, reason: reason.trim() } }),
    onSuccess: () => {
      toast('أُرسل طلب التعديل إلى الاعتماد');
      queryClient.invalidateQueries({ queryKey: ['changes'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      onClose();
    },
  });

  return (
    <Dialog open={open} title="طلب تعديل" onClose={() => { send.reset(); onClose(); }}>
      <p className="text-muted">لا يسري التعديل حتى يعتمده موظف غيرك.</p>
      {send.error && <Alert>{send.error.message}</Alert>}
      <Field label="ما الذي تعدّله؟">
        {(id) => <Select id={id} value={type} onChange={(e) => setType(e.target.value as ChangeType)}>{TYPES.map((t) => <option key={t} value={t}>{CHANGE_TYPES[t]}</option>)}</Select>}
      </Field>

      {type === 'UPDATE_FAMILY' && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
          <Field label="الهاتف">{(id) => <Input id={id} dir="ltr" value={contact.phone1} onChange={(e) => setContact({ ...contact, phone1: e.target.value })} />}</Field>
          <Field label="نوع العقار">
            {(id) => <Select id={id} value={contact.housing} onChange={(e) => setContact({ ...contact, housing: e.target.value as Housing | '' })}><option value="">لم يُحدَّد</option>{Object.entries(HOUSING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
          </Field>
          <Field label="المحلة">{(id) => <Input id={id} value={contact.mahalla} onChange={(e) => setContact({ ...contact, mahalla: e.target.value })} />}</Field>
          <Field label="أقرب نقطة دالة">{(id) => <Input id={id} value={contact.landmark} onChange={(e) => setContact({ ...contact, landmark: e.target.value })} />}</Field>
        </div>
      )}

      {type === 'SET_INCOMES' && (
        <div className="flex flex-col gap-3">
          {incomes.map((inc, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <div className="min-w-36 flex-1"><Field label="المصدر">{(id) => <Select id={id} value={inc.kind} onChange={(e) => setIncomes(incomes.map((x, j) => (j === i ? { ...x, kind: e.target.value as IncomeKind } : x)))}>{Object.entries(INCOME_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field></div>
              <div className="min-w-32 flex-1"><Field label="المبلغ">{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={inc.amount} onChange={(e) => setIncomes(incomes.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />}</Field></div>
              <Button variant="danger" onClick={() => setIncomes(incomes.filter((_, j) => j !== i))}>حذف</Button>
            </div>
          ))}
          <Button variant="secondary" className="self-start" onClick={() => setIncomes([...incomes, { kind: 'SALARY', amount: '' }])}>أضف مصدر دخل</Button>
        </div>
      )}

      {(type === 'UPDATE_MEMBER' || type === 'ADD_DOCUMENT') && (
        <Field label="الفرد">
          {(id) => <Select id={id} value={personId} onChange={(e) => setPersonId(e.target.value)}>{(type === 'UPDATE_MEMBER' ? family.members : living).map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}</Select>}
        </Field>
      )}
      {type === 'UPDATE_MEMBER' && (
        <>
          <div className="flex flex-wrap gap-x-6">
            <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={member.deceased} onChange={(e) => setMember({ ...member, deceased: e.target.checked })} />متوفى</label>
            <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={member.isOrphan} onChange={(e) => setMember({ ...member, isOrphan: e.target.checked })} />يتيم</label>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
            <Field label="الإعاقة">{(id) => <Input id={id} value={member.disability} onChange={(e) => setMember({ ...member, disability: e.target.value })} />}</Field>
            <Field label="المرض المزمن">{(id) => <Input id={id} value={member.chronicIllness} onChange={(e) => setMember({ ...member, chronicIllness: e.target.value })} />}</Field>
          </div>
        </>
      )}
      {type === 'ADD_DOCUMENT' && <DocumentFields idPrefix="change" value={doc} onChange={setDoc} onDuplicate={setDocDup} />}

      {type === 'ADD_MEMBER' && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
          <div className="col-span-full"><Field label="الاسم الكامل">{(id) => <Input id={id} value={added.fullName} onChange={(e) => setAdded({ ...added, fullName: e.target.value })} />}</Field></div>
          <Field label="الصلة">{(id) => <Select id={id} value={added.relation} onChange={(e) => setAdded({ ...added, relation: e.target.value as Relation })}>{Object.entries(RELATIONS).filter(([k]) => k !== 'HEAD').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
          <Field label="الجنس">{(id) => <Select id={id} value={added.gender} onChange={(e) => setAdded({ ...added, gender: e.target.value as 'M' | 'F' })}><option value="M">ذكر</option><option value="F">أنثى</option></Select>}</Field>
          <Field label="المواليد">{(id) => <Input id={id} type="date" value={added.birthDate} onChange={(e) => setAdded({ ...added, birthDate: e.target.value })} />}</Field>
        </div>
      )}

      {type === 'CHANGE_HEAD' && (candidates.length === 0 ? <Alert tone="warn">لا فرد حيّ في العائلة غير رب الأسرة. أضف الفرد أولاً.</Alert> : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3">
          <Field label="رب الأسرة الجديد" hint="يلزم أن تكون له وثيقة هوية مسجَّلة.">
            {(id) => <Select id={id} value={headChange.newHeadId} onChange={(e) => setHeadChange({ ...headChange, newHeadId: e.target.value })}>{candidates.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}</Select>}
          </Field>
          <Field label="صلة رب الأسرة السابق بالجديد" hint="إن توفي فسجّل وفاته بطلب «تغيير حال فرد».">
            {(id) => <Select id={id} value={headChange.formerHeadRelation} onChange={(e) => setHeadChange({ ...headChange, formerHeadRelation: e.target.value as Relation })}>{NON_HEAD.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
          </Field>
        </div>
      ))}

      {type === 'TRANSFER_MEMBER' && (others.length === 0 ? <Alert tone="warn">ليس في العائلة غير رب الأسرة، ورب الأسرة لا يُنقل.</Alert> : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
          <Field label="الفرد المنقول">
            {(id) => <Select id={id} value={transfer.personId} onChange={(e) => setTransfer({ ...transfer, personId: e.target.value })}>{others.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}</Select>}
          </Field>
          <Field label="رقم العائلة المنقول إليها">
            {(id) => <Input id={id} inputMode="numeric" dir="ltr" value={transfer.toFamilyNo} onChange={(e) => setTransfer({ ...transfer, toFamilyNo: e.target.value })} />}
          </Field>
          <Field label="صلته برب أسرتها">
            {(id) => <Select id={id} value={transfer.relation} onChange={(e) => setTransfer({ ...transfer, relation: e.target.value as Relation })}>{NON_HEAD.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
          </Field>
        </div>
      ))}

      <Field label="سبب التعديل (لازم)">
        {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: بطلب العائلة بعد انتقالها" />}
      </Field>
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="secondary" onClick={() => { send.reset(); onClose(); }}>إلغاء</Button>
        <Button disabled={!body || reason.trim().length < 3 || send.isPending} onClick={() => send.mutate()}>{send.isPending ? 'جارٍ الإرسال…' : 'أرسل للاعتماد'}</Button>
      </div>
    </Dialog>
  );
}
