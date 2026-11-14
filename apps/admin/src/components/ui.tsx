import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-strong',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-ground',
  danger: 'border border-danger text-danger bg-surface hover:bg-danger-soft',
  ghost: 'text-brand-strong hover:bg-brand-soft',
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children(id)}
      {hint && !error && <p className="text-sm text-muted">{hint}</p>}
      {error && <p role="alert" className="text-sm font-medium text-danger">{error}</p>}
    </div>
  );
}

const CONTROL = 'min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-ink placeholder:text-muted';
export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={`${CONTROL} ${props.className ?? ''}`} />;
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} className={`${CONTROL} ${props.className ?? ''}`} />;

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-line bg-surface p-5 ${className}`}>{children}</section>;
}

type Tone = 'ok' | 'warn' | 'info' | 'danger' | 'neutral';
const TONES: Record<Tone, string> = {
  ok: 'bg-brand-soft text-brand-strong',
  warn: 'bg-warn-soft text-warn-ink',
  info: 'bg-info-soft text-info-ink',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-ground text-muted',
};
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-semibold ${TONES[tone]}`}>{children}</span>;
}

export function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'ok' | 'warn'; children: ReactNode }) {
  return <div role="alert" className={`rounded-lg px-4 py-3 font-medium ${TONES[tone]}`}>{children}</div>;
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-bold">{title}</h1>
        {description && <p className="text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-ink backdrop:bg-ink/40"
    >
      {open && (
        <div className="flex flex-col gap-4 p-6">
          <h2 className="text-xl font-bold">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Icon({ d, className = 'size-5' }: { d: string; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={d} />
    </svg>
  );
}

export function Skeleton({ className = 'h-5 w-full' }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}
