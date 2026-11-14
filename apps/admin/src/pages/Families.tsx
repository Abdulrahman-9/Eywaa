import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { FAMILY_STATUS, TAGS, type FamilyStatus } from '../lib/labels';
import type { FamilyRow } from '../lib/types';

const PAGE = 25;
const CAN_REGISTER = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'];

export function Families() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<FamilyStatus | ''>('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(q.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (debounced) params.set('q', debounced);
  if (status) params.set('status', status);
  const list = useQuery({
    queryKey: ['families', debounced, status, page],
    queryFn: () => api<FamilyRow[]>(`/families?${params}`),
    placeholderData: keepPreviousData,
  });
  const rows = list.data ?? [];

  return (
    <>
      <PageHeader
        title="العوائل"
        description="ابحث برقم العائلة أو الاسم أو الهاتف."
        action={user && CAN_REGISTER.includes(user.role) && (
          <Link to="/families/new" className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand px-4 font-semibold text-white hover:bg-brand-strong">تسجيل عائلة</Link>
        )}
      />
      <Card className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-[2]">
          <Field label="بحث">
            {(id) => <Input id={id} type="search" placeholder="رقم العائلة أو الاسم أو الهاتف" value={q} onChange={(e) => setQ(e.target.value)} />}
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
      </Card>
      {list.error && <Alert>{list.error.message}</Alert>}
      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] border-collapse">
            <thead>
              <tr className="text-sm text-muted">
                {['رقم العائلة', 'رب الأسرة', 'الأفراد', 'الفئات', 'الحال', ''].map((h, i) => (
                  <th key={i} scope="col" className="border-b border-line px-4 py-3 text-start font-medium">{h || <span className="sr-only">فتح</span>}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.isPending && [0, 1, 2, 3].map((i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton /></td></tr>)}
              {rows.map((f) => (
                <tr key={f.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-semibold tabular-nums">{f.familyNo}</td>
                  <td className="px-4 py-3">
                    <div className="font-semibold">{f.headName ?? '—'}</div>
                    {f.phone1 && <div dir="ltr" className="text-end text-sm text-muted">{f.phone1}</div>}
                  </td>
                  <td className="px-4 py-3">{f.members}</td>
                  <td className="px-4 py-3 text-sm">{f.tags.map((t) => TAGS[t]).join('، ') || '—'}</td>
                  <td className="px-4 py-3"><Badge tone={FAMILY_STATUS[f.status].tone}>{FAMILY_STATUS[f.status].label}</Badge></td>
                  <td className="px-4 py-2 text-end">
                    <Link to={`/families/${f.id}`} className="inline-flex min-h-9 items-center rounded-lg border border-line-strong px-3.5 font-semibold hover:bg-ground">فتح</Link>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-muted">{debounced || status ? 'لا عائلة تطابق البحث.' : 'لم تُسجَّل عائلة بعد.'}</td></tr>
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
