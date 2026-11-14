import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Alert, Button, Card, PageHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';

interface Entry {
  seq: string;
  at: string;
  action: string;
  entity: string;
  entity_id: string;
  payload: Record<string, unknown>;
  actor: string | null;
}

const ACTIONS: Record<string, string> = {
  'auth.login': 'دخول',
  'auth.locked': 'قفل حساب لكثرة المحاولات',
  'auth.password_change': 'تغيير كلمة المرور',
  'auth.totp_enable': 'تفعيل التحقق بعاملين',
  'auth.totp_disable': 'تعطيل التحقق بعاملين',
  'user.create': 'إنشاء مستخدم',
  'user.update': 'تعديل مستخدم',
  'family.create': 'تسجيل عائلة',
  'family.approve': 'اعتماد عائلة',
  'family.reject': 'رفض عائلة',
  'duplicate_flag.resolve': 'فصل في شبهة تكرار',
  'setting.change': 'تغيير إعداد',
  'attachment.upload': 'رفع مرفق',
  'attachment.view': 'اطلاع على مرفق',
  'attachment.delete': 'حذف مرفق',
  'change.request': 'طلب تعديل',
  'change.approve': 'اعتماد تعديل',
  'change.reject': 'رفض تعديل',
  'point.create': 'إنشاء نقطة توزيع',
  'campaign.create': 'إنشاء حملة',
  'campaign.submit': 'إرسال حملة للاعتماد',
  'campaign.approve': 'اعتماد حملة',
  'campaign.reject': 'رفض حملة',
  'campaign.cancel': 'إلغاء حملة',
  'campaign.close': 'إقفال حملة',
  'campaign.tokens_export': 'اطلاع على رموز حملة',
  'delivery.redeem': 'تسليم',
  'delivery.sync': 'تسليم دون اتصال',
  'delivery.double': 'تسليم مرتين',
  'notification.compose': 'إنشاء إرسال جماعي',
  'notification.approve': 'اعتماد إرسال جماعي',
  'notification.reject': 'رفض إرسال جماعي',
  'item.create': 'إضافة صنف',
  'stock.receipt': 'وارد مخزن',
  'stock.transfer': 'تحويل مخزن',
  'stock.return': 'راجع مخزن',
  'stock.waste': 'تسجيل تالف',
  'stock.stocktake': 'جرد',
  'stock.approve': 'اعتماد حركة مخزن',
  'stock.reject': 'رفض حركة مخزن',
  'fund.create': 'إنشاء صندوق',
  'ledger.receipt': 'سند قبض',
  'ledger.payment': 'سند صرف',
  'ledger.approve': 'اعتماد قيد',
  'ledger.reject': 'رفض قيد',
  'ledger.reverse': 'عكس قيد',
  'custody.issue': 'تسليم عهدة',
  'custody.close': 'إقفال عهدة',
  'contractor.create': 'إضافة مقاول',
  'housing.create': 'إنشاء مشروع بناء',
  'housing.approve': 'اعتماد مشروع بناء',
  'housing.reject': 'رفض مشروع بناء',
  'housing.claim': 'طلب صرف مرحلة',
  'housing.verify': 'زيارة تحقق',
  'housing.send_back': 'إعادة مرحلة إلى المقاول',
  'housing.pay': 'صرف دفعة مرحلة',
  'donor.create': 'إضافة متبرع',
  'report.export': 'تنزيل تقرير',
  'program.create': 'إنشاء برنامج',
  'program.update': 'تعديل برنامج',
  'scoring.propose': 'اقتراح إصدار للنقاط',
  'scoring.approve': 'اعتماد إصدار للنقاط',
  'scoring.reject': 'رفض إصدار للنقاط',
  'family.remove': 'شطب عائلة',
  'family.restore': 'إعادة عائلة مشطوبة',
  'inspection.assign': 'تكليف بكشف ميداني',
  'inspection.report': 'رفع كشف ميداني',
  'inspection.approve': 'اعتماد كشف ميداني',
  'inspection.reject': 'ردّ كشف ميداني',
  'inspection.cancel': 'إلغاء تكليف بكشف',
  'reassessment.open': 'فتح إعادة تقييم',
  'reassessment.visit': 'زيارة إعادة تقييم',
  'reassessment.close': 'اعتماد إعادة تقييم',
  'reassessment.cancel': 'إلغاء إعادة تقييم',
  'quick.create': 'طلب تسجيل سريع',
  'quick.invite': 'دعوة صاحب طلب تسجيل',
  'quick.assign': 'إسناد زيارة لطلب تسجيل',
  'quick.complete': 'استكمال طلب تسجيل',
  'quick.dismiss': 'صرف النظر عن طلب تسجيل',
  'grant.create': 'تخويل بالصرف لغير المسجَّلين',
  'grant.revoke': 'سحب تخويل',
  'grant.case': 'صرف بتخويل',
  'payout.create': 'كشف دفع',
  'payout.approve': 'اعتماد كشف دفع',
  'payout.reject': 'رفض كشف دفع',
  'payout.export': 'تنزيل كشف دفع',
  'device.register': 'تسجيل جهاز ميدان',
  'device.revoke': 'سحب جهاز ميدان',
  'device.reassign': 'نقل جهاز إلى موظف آخر',
  'point.update': 'تعديل نقطة توزيع',
  'campaign.update': 'تعديل حملة',
  'campaign.add_family': 'إضافة عائلة إلى حملة',
  'campaign.remove_family': 'إخراج عائلة من حملة',
  'campaign.remind': 'تذكير من لم يستلم',
  'campaign.point_lead': 'تعيين مسؤول نقطة',
  'box.create': 'إضافة صندوق تبرعات',
  'box.update': 'تعديل صندوق تبرعات',
  'box.retire': 'رفع صندوق من موقعه',
  'box.restore': 'إعادة صندوق إلى العمل',
  'box.collect': 'فتح صندوق تبرعات',
  'donation.report': 'تبرع بيد متعهد',
  'donation.receive': 'استلام تبرع عيني',
  'donation.cancel': 'إلغاء بلاغ تبرع',
  'custody.receive': 'استلام من ذمة',
  'goods.ack': 'شهادة باستلام مواد',
};

const PAGE = 50;

export function Audit() {
  const log = useInfiniteQuery({
    queryKey: ['audit'],
    queryFn: ({ pageParam }) => api<Entry[]>(`/audit?limit=${PAGE}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1].seq : undefined),
  });
  const verify = useMutation({
    mutationFn: () => api<{ ok: boolean; entries: number; brokenAtSeq: number | null }>('/audit/verify'),
  });
  const entries = log.data?.pages.flat() ?? [];

  return (
    <>
      <PageHeader
        title="سجل التدقيق"
        description="كل عملية في النظام لها سطر هنا: من فعل، وماذا، ومتى. يُضاف إليه ولا يُعدَّل."
        action={<Button variant="secondary" disabled={verify.isPending} onClick={() => verify.mutate()}>{verify.isPending ? 'جارٍ التحقق…' : 'تحقق من سلامة السجل'}</Button>}
      />
      {verify.data && (verify.data.ok
        ? <Alert tone="ok">السجل سليم: فُحصت {formatNumber(verify.data.entries)} عملية ولم يُعبث بشيء منها.</Alert>
        : <Alert>السجل معبوث به: انكسرت السلسلة عند العملية رقم {verify.data.brokenAtSeq}. أبلغ مدير النظام فوراً.</Alert>)}
      {(log.error || verify.error) && <Alert>{(log.error ?? verify.error)!.message}</Alert>}

      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] border-collapse">
            <thead>
              <tr className="text-sm text-muted">
                {['الرقم', 'الوقت', 'الموظف', 'العملية', 'التفاصيل'].map((h) => (
                  <th key={h} scope="col" className="border-b border-line px-4 py-3 text-start font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {log.isPending && [0, 1, 2, 3].map((i) => <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton /></td></tr>)}
              {entries.map((e) => (
                <tr key={e.seq} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3 tabular-nums text-muted">{e.seq}</td>
                  <td className="whitespace-nowrap px-4 py-3">{formatDateTime(e.at)}</td>
                  <td className="px-4 py-3 font-semibold" dir="ltr" style={{ textAlign: 'right' }}>{e.actor ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3">{ACTIONS[e.action] ?? e.action}</td>
                  <td className="px-4 py-3">
                    {Object.keys(e.payload).length > 0 && (
                      <code dir="ltr" className="block max-w-md break-all text-start text-sm text-muted">{JSON.stringify(e.payload)}</code>
                    )}
                  </td>
                </tr>
              ))}
              {log.isSuccess && entries.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-muted">لا عمليات بعد.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      {log.hasNextPage && (
        <Button variant="secondary" className="self-center" disabled={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>
          {log.isFetchingNextPage ? 'جارٍ التحميل…' : 'عرض الأقدم'}
        </Button>
      )}
    </>
  );
}
