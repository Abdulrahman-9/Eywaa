import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deltaText } from '../components/Inspections';
import { VisitsTodo } from '../components/Reassessments';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { formatAgo } from '../lib/format';
import { useAuth } from '../lib/auth';
import { FAMILY_STATUS, TAGS, type FamilyStatus } from '../lib/labels';
import type { FamilyRow } from '../lib/types';
import { CLASS_AR } from './Scoring';

const PAGE = 25;
const CAN_REGISTER = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'];

export function Families() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<FamilyStatus | ''>('');
  const [cls, setCls] = useState('');
  const [inspection, setInspection] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(q.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (debounced) params.set('q', debounced);
  if (status) params.set('status', status);
  if (cls) params.set('class', cls);
  if (inspection) params.set('inspection', inspection);
  const list = useQuery({
    queryKey: ['families', debounced, status, cls, inspection, page],
    queryFn: () => api<FamilyRow[]>(`/families?${params}`),
    placeholderData: keepPreviousData,
  });
  const rows = list.data ?? [];

  return (
    <>
      <PageHeader
        title="العوائل"
        description="ابحث برقم العائلة أو الاسم أو الهاتف أو رقم الوثيقة."
        action={user && CAN_REGISTER.includes(user.role) && (
          <div className="flex flex-wrap gap-2">
            {user.role !== 'FIELD_RESEARCHER' && (
              <Link to="/families/import" className="inline-flex min-h-11 items-center rounded-lg border border-line-strong bg-surface px-4 font-semibold hover:bg-ground">استيراد من Excel</Link>
            )}
            <Link to="/families/new" className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand px-4 font-semibold text-white hover:bg-brand-strong">تسجيل عائلة</Link>
          </div>
        )}
      />
      {user && CAN_REGISTER.includes(user.role) && <VisitsTodo />}
      <Card className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-[2]">
          <Field label="بحث">
            {(id) => <Input id={id} type="search" placeholder="رقم العائلة أو الاسم أو الهاتف أو رقم الوثيقة" value={q} onChange={(e) => setQ(e.target.value)} />}
          </Field>
        </div>
        <div className="min-w-40 flex-1">
          <Field label="الحال">
            {(id) => (
              <Select id={id} value={status} onChange={(e) => { setStatus(e.target.value as FamilyStatus | ''); setPage(0); }}>
                <option value="">الكل</option>
                {Object.entries(FAMILY_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <div className="min-w-32 flex-1">
          <Field label="الفئة">
            {(id) => (
              <Select id={id} value={cls} onChange={(e) => { setCls(e.target.value); setPage(0); }}>
                <option value="">الكل</option>
                {Object.entries(CLASS_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <div className="min-w-40 flex-1">
          <Field label="الكشف الميداني">
            {(id) => (
              <Select id={id} value={inspection} onChange={(e) => { setInspection(e.target.value); setPage(0); }}>
                <option value="">الكل</option>
                <option value="NONE">غير مكشوفة</option>
                <option value="OPEN">قيد الكشف</option>
                <option value="DONE">مكشوفة</option>
              </Select>
            )}
          </Field>
        </div>
      </Card>
      {list.error && <Alert>{list.error.message}</Alert>}
      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] border-collapse">
            <thead>
              <tr className="text-sm text-muted">
                {['رقم العائلة', 'رب الأسرة', 'الأفراد', 'الفئة والنقاط', 'الوسوم', 'الحال', 'الكشف', ''].map((h, i) => (
                  <th key={i} scope="col" className="border-b border-line px-4 py-3 text-start font-medium">{h || <span className="sr-only">فتح</span>}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.isPending && [0, 1, 2, 3].map((i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton /></td></tr>)}
              {rows.map((f) => (
                <tr key={f.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-semibold tabular-nums">{f.familyNo}</td>
                  <td className="px-4 py-3">
                    <div className="font-semibold">{f.headName ?? '—'}</div>
                    {f.phone1 && <div dir="ltr" className="text-end text-sm text-muted">{f.phone1}</div>}
                  </td>
                  <td className="px-4 py-3">{f.members}</td>
                  <td className="whitespace-nowrap px-4 py-3">{f.score ? <><strong>{CLASS_AR[f.score.class]}</strong> <span className="text-muted">{f.score.points} نقطة</span></> : <span className="text-muted">—</span>}</td>
                  <td className="px-4 py-3 text-sm">{f.tags.map((t) => TAGS[t]).join('، ') || '—'}</td>
                  <td className="px-4 py-3"><Badge tone={FAMILY_STATUS[f.status].tone}>{FAMILY_STATUS[f.status].label}</Badge></td>
                  <td className="whitespace-nowrap px-4 py-3" data-testid="inspection-state">
                    {f.inspection.state === 'OPEN' ? <Badge tone="info">قيد الكشف</Badge> : f.inspection.state === 'DONE' ? <Badge tone="ok">مكشوفة</Badge> : f.status === 'REJECTED' || f.status === 'REMOVED' ? <span className="text-muted">—</span> : <Badge>غير مكشوفة</Badge>}
                    {f.inspection.delta !== 0 && <strong className={`ms-1.5 tabular-nums ${f.inspection.delta > 0 ? 'text-info-ink' : 'text-warn-ink'}`} title="تعديل الكشف على النقاط">{deltaText(f.inspection.delta)}</strong>}
                    {f.inspection.at && <div className="text-sm text-muted">{formatAgo(f.inspection.at)}</div>}
                  </td>
                  <td className="px-4 py-2 text-end">
                    <Link to={`/families/${f.id}`} className="inline-flex min-h-9 items-center rounded-lg border border-line-strong px-3.5 font-semibold hover:bg-ground">فتح</Link>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-muted">{debounced || status || cls || inspection ? 'لا عائلة تطابق البحث.' : 'لم تُسجَّل عائلة بعد.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 text-sm text-muted">
          <span>الصفحة {page + 1}</span>
          <div className="ms-auto flex gap-2">
            <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>السابق</Button>
            <Button variant="secondary" disabled={rows.length < PAGE} onClick={() => setPage(page + 1)}>التالي</Button>
          </div>
        </div>
      </Card>
    </>
  );
}
