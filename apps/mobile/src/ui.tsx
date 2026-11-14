import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useId } from 'react';

const VARIANTS = {
  primary: 'bg-brand text-white active:bg-brand-strong',
  secondary: 'border border-line-strong bg-surface text-ink active:bg-ground',
  danger: 'border border-danger bg-surface text-danger active:bg-danger-soft',
};

/** أزرار كبيرة: تُضغط بإبهام في الشمس والزحام. */
export function Button({ variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return <button type="button" {...props} className={`inline-flex min-h-14 items-center justify-center gap-2 rounded-xl px-5 text-lg font-semibold disabled:opacity-50 ${VARIANTS[variant]} ${className}`} />;
}

export function Field({ label, hint, error, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="font-semibold">{label}</label>
      <input id={id} {...props} aria-invalid={error ? true : undefined} className={`min-h-14 w-full min-w-0 rounded-xl border bg-surface px-4 text-lg ${error ? 'border-danger' : 'border-line-strong'} ${props.className ?? ''}`} />
      {error ? <span className="text-danger">{error}</span> : hint && <span className="text-sm text-muted">{hint}</span>}
    </div>
  );
}

export function SelectField({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="font-semibold">{label}</label>
      <select id={id} {...props} className="min-h-14 w-full min-w-0 rounded-xl border border-line-strong bg-surface px-4 text-lg">{children}</select>
    </div>
  );
}

export function Notice({ tone = 'danger', children }: { tone?: 'danger' | 'warn' | 'ok'; children: ReactNode }) {
  const tones = { danger: 'bg-danger-soft text-danger', warn: 'bg-warn-soft text-warn-ink', ok: 'bg-brand-soft text-brand-strong' };
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={`rounded-xl px-4 py-3 font-semibold ${tones[tone]}`}>{children}</div>;
}

export function Screen({ title, onBack, status, children }: { title: string; onBack?: () => void; status?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col overflow-x-clip">
      <header className="sticky top-0 z-10 flex min-h-16 items-center gap-3 bg-nav px-4 pt-[env(safe-area-inset-top)] text-white">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="رجوع" className="-ms-2 grid size-12 place-items-center rounded-full active:bg-white/10">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        )}
        <h1 className="min-w-0 flex-1 truncate text-xl font-bold">{title}</h1>
        {status}
      </header>
      <main className="flex min-w-0 flex-1 flex-col gap-4 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-4">{children}</main>
    </div>
  );
}

export const formatNumber = (n: number) => n.toLocaleString('en-US');
/** أرقام عربية تُكتب من لوحة الهاتف تصير لاتينية، ويُحذف ما سواها. */
export const digits = (v: string) => v.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/\D/g, '');
const dayTime = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
/** «ص» و«م» تلزمان الساعة: لا تنفصلان عنها إلى أول السطر التالي. */
const keepPeriod = (s: string) => s.replace(/\s+(?=[صم]$)/, ' ');
export const formatDayTime = (iso: string) => keepPeriod(dayTime.format(new Date(iso)));
export const formatAgo = (iso: string | null) => {
  if (!iso) return 'لم يكن';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? 'اليوم' : days === 1 ? 'أمس' : days === 2 ? 'منذ يومين' : days <= 10 ? `منذ ${days} أيام` : `منذ ${days} يوماً`;
};

export function TextArea({ label, hint, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="font-semibold">{label}</label>
      <textarea id={id} rows={3} {...props} className="w-full min-w-0 rounded-xl border border-line-strong bg-surface px-4 py-3 text-lg" />
      {hint && <span className="text-sm text-muted">{hint}</span>}
    </div>
  );
}

export const formatTime = (iso: string) => keepPeriod(new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso)));
