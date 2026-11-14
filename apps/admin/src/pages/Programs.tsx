import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '../components/toast';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatNumber } from '../lib/format';
import { HOUSING, TAGS, type Housing, type Tag } from '../lib/labels';
import { CLASS_AR } from './Scoring';

interface Rules { classes?: string[]; belowPovertyLine?: true; tagsAny?: Tag[]; housingIn?: Housing[]; minMembers?: number; hasOrphans?: true; hasDisabled?: true }
type Amount =
  | { type: 'FIXED'; value: number }
  | { type: 'PER_MEMBER'; value: number; max?: number }
  | { type: 'PER_ORPHAN'; value: number; max?: number }
  | { type: 'BY_SIZE'; tiers: { upTo: number | null; value: number }[] };
export interface Program {
  id: string; name: string; kind: 'MONEY' | 'IN_KIND' | 'PROJECT' | 'SERVICE'; unit: string; rules: Rules; amount: Amount;
  minGapDays: number; active: boolean; eligibleFamilies: number; eligibleQuantity: number;
}
type Draft = Omit<Program, 'id' | 'eligibleFamilies' | 'eligibleQuantity'> & { id?: string };

export const KINDS = { MONEY: 'مال', IN_KIND: 'عيني', PROJECT: 'مشروع', SERVICE: 'خدمة' } as const;
const AMOUNT_TYPES = { FIXED: 'مقدار ثابت', BY_SIZE: 'بحسب عدد الأفراد', PER_MEMBER: 'لكل فرد', PER_ORPHAN: 'لكل يتيم' } as const;
const blank = (): Draft => ({ name: '', kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 1 }, minGapDays: 0, active: true });
const int = (v: string) => Number(v.replace(/\D/g, '')) || 0;

export function describeAmount(a: Amount, unit: string): string {
  if (a.type === 'FIXED') return `${formatNumber(a.value)} ${unit}`;
  if (a.type === 'PER_MEMBER') return `${formatNumber(a.value)} ${unit} لكل فرد`;
  if (a.type === 'PER_ORPHAN') return `${formatNumber(a.value)} ${unit} لكل يتيم`;
  return `${a.tiers[0].value} إلى ${a.tiers[a.tiers.length - 1].value} ${unit} بحسب الأفراد`;
}

function toggle<T>(list: T[] | undefined, item: T): T[] | undefined {
  const next = list?.includes(item) ? list.filter((x) => x !== item) : [...(list ?? []), item];
  return next.length ? next : undefined;
}

function Editor({ draft, setDraft, onClose }: { draft: Draft; setDraft: (d: Draft) => void; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const rules = draft.rules;
  const setRules = (patch: Partial<Rules>) => {
    const next = { ...rules, ...patch };
    for (const k of Object.keys(next) as (keyof Rules)[]) if (next[k] === undefined) delete next[k];
    setDraft({ ...draft, rules: next });
  };
  const amountOk = draft.amount.type === 'BY_SIZE' ? draft.amount.tiers.every((t) => t.value > 0) : draft.amount.value > 0;
  const preview = useQuery({
    queryKey: ['program-preview', JSON.stringify([rules, draft.amount])],
    queryFn: () => api<{ families: number; quantity: number }>('/programs/preview', { method: 'POST', body: { rules, amount: draft.amount } }),
    enabled: amountOk,
    retry: false,
  });
  const save = useMutation({
    mutationFn: () => {
      const { id, ...body } = draft;
      return api(id ? `/programs/${id}` : '/programs', { method: id ? 'PUT' : 'POST', body });
    },
    onSuccess: () => { toast(draft.id ? 'حُفظ البرنامج' : 'أُنشئ البرنامج'); queryClient.invalidateQueries({ queryKey: ['programs'] }); onClose(); },
  });

  return (
    <Card className="flex min-w-0 flex-[2_1_32rem] flex-col gap-5">
      <h2 className="text-xl font-bold">{draft.id ? 'تعديل البرنامج' : 'برنامج جديد'}</h2>
      {save.error && <Alert>{save.error.message}</Alert>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
        <div className="col-span-full"><Field label="اسم البرنامج">{(id) => <Input id={id} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field></div>
        <Field label="نوعه">{(id) => <Select id={id} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft['kind'] })}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        <Field label="وحدة المقدار" hint="دينار، سلة، قطعة…">{(id) => <Input id={id} value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />}</Field>
        <Field label="أقل فاصل بين عطاءين (يوماً)">{(id) => <Input id={id} inputMode="numeric" value={String(draft.minGapDays)} onChange={(e) => setDraft({ ...draft, minGapDays: int(e.target.value) })} />}</Field>
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <h3 className="font-bold">من يستحق؟</h3>
        <p className="text-sm text-muted">تستحق العائلة إذا اجتمع فيها كل ما تحدده هنا. ما تتركه فارغاً لا يُشترط.</p>
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="mb-1 text-sm font-medium">الفئة هي إحدى</legend>
          {Object.entries(CLASS_AR).map(([k, v]) => (
            <label key={k} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-3.5">
              <input type="checkbox" className="size-[18px] accent-brand" checked={!!rules.classes?.includes(k)} onChange={() => setRules({ classes: toggle(rules.classes, k)?.sort() })} />{v}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="mb-1 text-sm font-medium">من الفئات المشمولة (أيّ واحدة منها)</legend>
          {(Object.keys(TAGS) as Tag[]).map((t) => (
            <label key={t} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-3.5">
              <input type="checkbox" className="size-[18px] accent-brand" checked={!!rules.tagsAny?.includes(t)} onChange={() => setRules({ tagsAny: toggle(rules.tagsAny, t) })} />{TAGS[t]}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="mb-1 text-sm font-medium">نوع السكن</legend>
          {(Object.keys(HOUSING) as Housing[]).map((h) => (
            <label key={h} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-3.5">
              <input type="checkbox" className="size-[18px] accent-brand" checked={!!rules.housingIn?.includes(h)} onChange={() => setRules({ housingIn: toggle(rules.housingIn, h) })} />{HOUSING[h]}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={!!rules.belowPovertyLine} onChange={(e) => setRules({ belowPovertyLine: e.target.checked || undefined })} />دخل الفرد دون خط الفقر</label>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={!!rules.hasOrphans} onChange={(e) => setRules({ hasOrphans: e.target.checked || undefined })} />فيها يتيم</label>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={!!rules.hasDisabled} onChange={(e) => setRules({ hasDisabled: e.target.checked || undefined })} />فيها معاق</label>
        </div>
        <div className="max-w-56"><Field label="أقل عدد للأفراد (اختياري)">{(id) => <Input id={id} inputMode="numeric" value={rules.minMembers ? String(rules.minMembers) : ''} onChange={(e) => setRules({ minMembers: int(e.target.value) || undefined })} />}</Field></div>
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <h3 className="font-bold">كم تستحق؟</h3>
        <div className="max-w-64">
          <Field label="طريقة المقدار">
            {(id) => (
              <Select id={id} value={draft.amount.type} onChange={(e) => {
                const type = e.target.value as Amount['type'];
                setDraft({ ...draft, amount: type === 'BY_SIZE' ? { type, tiers: [{ upTo: 4, value: 1 }, { upTo: 8, value: 2 }, { upTo: null, value: 3 }] } : { type, value: 1 } });
              }}>
                {Object.entries(AMOUNT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            )}
          </Field>
        </div>
        {draft.amount.type !== 'BY_SIZE' ? (
          <div className="max-w-56"><Field label={`المقدار (${draft.unit || 'وحدة'})`}>{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={String(draft.amount.type !== 'BY_SIZE' ? draft.amount.value : '')} onChange={(e) => setDraft({ ...draft, amount: { ...draft.amount, value: int(e.target.value) } as Amount })} />}</Field></div>
        ) : (
          <div className="flex flex-col gap-2">
            {draft.amount.tiers.map((t, i, tiers) => (
              <div key={i} className="flex flex-wrap items-end gap-3">
                <div className="w-44"><Field label={t.upTo === null ? 'ما فوق ذلك' : 'حتى عدد أفراد'}>{(id) => <Input id={id} inputMode="numeric" disabled={t.upTo === null} value={t.upTo === null ? '—' : String(t.upTo)} onChange={(e) => setDraft({ ...draft, amount: { type: 'BY_SIZE', tiers: tiers.map((x, j) => (j === i ? { ...x, upTo: int(e.target.value) } : x)) } })} />}</Field></div>
                <div className="w-44"><Field label={`المقدار (${draft.unit || 'وحدة'})`}>{(id) => <Input id={id} inputMode="numeric" value={String(t.value)} onChange={(e) => setDraft({ ...draft, amount: { type: 'BY_SIZE', tiers: tiers.map((x, j) => (j === i ? { ...x, value: int(e.target.value) } : x)) } })} />}</Field></div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-brand-soft p-4">
        <div className="min-w-0 flex-1">
          {preview.isPending && amountOk ? <Skeleton className="h-6 w-48" />
            : preview.error ? <span className="font-medium text-danger">{preview.error.message}</span>
            : preview.data ? <><strong className="text-lg">{formatNumber(preview.data.families)} عائلة تستحق الآن</strong><div className="text-sm text-[#33423C]">وحاجتها {formatNumber(preview.data.quantity)} {draft.unit}</div></>
            : <span className="text-muted">أدخل مقداراً صحيحاً.</span>}
        </div>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />فعّال</label>
      </div>
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>إلغاء</Button>
        <Button disabled={draft.name.trim().length < 2 || !draft.unit.trim() || !amountOk || !!preview.error || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'جارٍ الحفظ…' : draft.id ? 'احفظ التعديل' : 'أنشئ البرنامج'}</Button>
      </div>
    </Card>
  );
}

export function Programs() {
  const { user } = useAuth();
  const [draft, setDraft] = useState<Draft | null>(null);
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api<Program[]>('/programs') });
  const isAdmin = user?.role === 'ADMIN';
  return (
    <>
      <PageHeader title="البرامج" description="كل برنامج نوع من العطاء، له شروطه ومقداره وتواتره."
        action={isAdmin && <Button onClick={() => setDraft(blank())}>برنامج جديد</Button>} />
      {programs.error && <Alert>{programs.error.message}</Alert>}
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-3">
          {programs.isPending && <Skeleton className="h-24 w-full" />}
          {programs.data?.length === 0 && <Card className="py-8 text-center text-muted">لا برامج بعد. أنشئ أول برنامج ليُحسب مستحقوه.</Card>}
          {programs.data?.map((p) => (
            <Card key={p.id} className={`flex flex-col gap-1.5 ${draft?.id === p.id ? '!border-2 !border-brand' : ''}`}>
              <div className="flex items-center justify-between gap-3"><strong className="text-lg">{p.name}</strong>{p.active ? <span className="text-sm text-muted">{KINDS[p.kind]}</span> : <Badge>معطَّل</Badge>}</div>
              <span className="text-sm text-[#33423C]">{describeAmount(p.amount, p.unit)}{p.minGapDays ? ` · كل ${p.minGapDays} يوماً على الأقل` : ''}</span>
              {p.active && <span className="text-sm">يستحقه الآن <strong>{formatNumber(p.eligibleFamilies)}</strong> عائلة، وحاجتها {formatNumber(p.eligibleQuantity)} {p.unit}</span>}
              {isAdmin && <Button variant="secondary" className="self-start" onClick={() => setDraft({ id: p.id, name: p.name, kind: p.kind, unit: p.unit, rules: p.rules, amount: p.amount, minGapDays: p.minGapDays, active: p.active })}>تعديل</Button>}
            </Card>
          ))}
        </div>
        {draft && <Editor key={draft.id ?? 'new'} draft={draft} setDraft={setDraft} onClose={() => setDraft(null)} />}
      </div>
    </>
  );
}
