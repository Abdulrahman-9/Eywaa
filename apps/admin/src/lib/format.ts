const number = new Intl.NumberFormat('en-US');
export const formatNumber = (n: number) => number.format(n);

const dateTime = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

const longDate = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const formatLongDate = (d: Date) => longDate.format(d);

const dateOnly = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { dateStyle: 'medium' });
export const formatDate = (iso: string) => dateOnly.format(new Date(iso));

export function age(birthDate: string | null): string {
  if (!birthDate) return '—';
  const b = new Date(birthDate), n = new Date();
  let years = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) years--;
  return years < 1 ? 'دون السنة' : String(years);
}

export const formatBytes = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} ك.ب` : `${(n / 1024 / 1024).toFixed(1)} م.ب`);

/** كم مضى: «اليوم»، «أمس»، «منذ 5 أيام». */
export function formatAgo(iso: string | null): string {
  if (!iso) return 'لم يكن';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'اليوم';
  if (days === 1) return 'أمس';
  if (days === 2) return 'منذ يومين';
  return days <= 10 ? `منذ ${days} أيام` : `منذ ${days} يوماً`;
}
export const formatDays = (n: number) => (n === 0 ? 'اليوم' : n === 1 ? 'يوم واحد' : n === 2 ? 'يومان' : n <= 10 ? `${n} أيام` : `${n} يوماً`);

/** الأرقام العربية والفارسية إلى لاتينية: من كتب «٥٠٠٠٠» بلوحة مفاتيحه العربية يُقرأ ما كتبه، لا صفراً. */
export const latin = (v: string) => v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
/** خانات النص وحدها، بعد توحيد الأرقام. */
export const digits = (v: string) => latin(v).replace(/\D/g, '');
