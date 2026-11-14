import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, PageHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';

interface Token { entitlementId: string; serial: number; familyNo: string; headName: string; point: string; quantity: number; unit: string; token: string; code: string }

export function Qr({ value, label = 'رمز الاستلام' }: { value: string; label?: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toString(value, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }).then((s) => { if (live) setSvg(s); });
    return () => { live = false; };
  }, [value]);
  return <div role="img" aria-label={label} className="size-36 flex-none" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** بطاقات الاستلام للطباعة: لمن لا واتساب له، أو قبل أن تُربط الرسائل. */
export function Tokens() {
  const { id = '' } = useParams();
  // تُجلب مرة واحدة: كل جلب يُسجَّل في سجل التدقيق.
  const q = useQuery({ queryKey: ['tokens', id], queryFn: () => api<Token[]>(`/campaigns/${id}/tokens`), staleTime: Infinity, refetchOnWindowFocus: false, retry: false });
  return (
    <>
      <div className="print:hidden">
        <PageHeader title="رموز الاستلام" description="لكل عائلة لم تستلم بعد بطاقة فيها رمزها. الاطلاع على هذه الصفحة يُسجَّل باسمك."
          action={<div className="flex flex-wrap gap-2.5"><Link to={`/campaigns/${id}`} className="inline-flex min-h-11 items-center rounded-lg border border-line-strong bg-surface px-4 font-semibold">العودة إلى الحملة</Link><Button disabled={!q.data} onClick={() => window.print()}>اطبع البطاقات</Button></div>} />
      </div>
      {q.isPending && <Skeleton className="h-40 w-full" />}
      {q.error && <Alert>{q.error.message}</Alert>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(21rem,1fr))] gap-4 print:grid-cols-2 print:gap-3">
        {q.data?.map((t) => (
          <article key={t.entitlementId} data-token={t.token} className="flex break-inside-avoid items-center gap-4 rounded-xl border border-line-strong bg-white p-4">
            <Qr value={t.token} />
            <div className="flex min-w-0 flex-col gap-1">
              <strong className="text-lg leading-snug">{t.headName}</strong>
              <span>رقم العائلة: <strong className="tabular-nums">{t.familyNo}</strong></span>
              <span>تستلم: <strong>{t.quantity} {t.unit}</strong></span>
              <span>من نقطة: <strong>{t.point}</strong></span>
              <span className="text-sm">الرمز الرقمي: <strong dir="ltr" className="tabular-nums tracking-wider">{t.code}</strong></span>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
