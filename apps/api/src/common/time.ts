/**
 * المنطقة التي يعيش فيها المركز. بها تُقطع الأيام والشهور (في القاعدة، بإعداد الاتصال) وتُكتب الأوقات في الرسائل والكشوف.
 * عملية الخادم نفسها تبقى على UTC: أعمدة التاريخ تخرج منها كما هي، فلا ينزاح يوم عند العميل.
 */
export const APP_TZ = process.env.APP_TIMEZONE || 'Asia/Baghdad';

const pad = (n: number) => String(n).padStart(2, '0');
const parts = new Intl.DateTimeFormat('en-US', { timeZone: APP_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** كم تسبق المنطقةُ التوقيتَ العالمي عند لحظة بعينها، بالميلي ثانية. */
function offsetMs(at: Date): number {
  const p = Object.fromEntries(parts.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** عمود التاريخ كما يعيده pg (منتصف ليل العملية) أو نصه، إلى YYYY-MM-DD. */
export function dayOf(d: Date | string): string {
  return typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** اللحظة التي يبدأ فيها اليوم في منطقة المركز. */
export function startOfDay(day: Date | string): Date {
  const utc = new Date(`${dayOf(day)}T00:00:00Z`);
  return new Date(utc.getTime() - offsetMs(utc));
}

/** آخر ثانية من اليوم في منطقة المركز. */
export function endOfDay(day: Date | string): Date {
  return new Date(startOfDay(day).getTime() + 86_400_000 - 1000);
}

/** تاريخ اليوم في منطقة المركز. */
export function today(): string {
  const p = Object.fromEntries(parts.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** منسّق وقت عربي بأرقام لاتينية، في منطقة المركز لا في منطقة الخادم. */
export const arFormat = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { timeZone: APP_TZ, ...options });
