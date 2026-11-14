const number = new Intl.NumberFormat('en-US');
export const formatNumber = (n: number) => number.format(n);

const dateTime = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

const longDate = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const formatLongDate = (d: Date) => longDate.format(d);
