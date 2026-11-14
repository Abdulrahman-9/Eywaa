import * as RadixDialog from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { Check, Loader2, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/*
 * مكوّنات الواجهة المشتركة، على نسق shadcn/ui:
 * Radix للسلوك وإتاحة الوصول، وclass-variance-authority للأشكال، وlucide للأيقونات، وmotion للحركة.
 */

const button = cva(
  'inline-flex min-h-11 select-none items-center justify-center gap-2 rounded-lg px-4 font-semibold transition-[background-color,box-shadow,transform,border-color] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-55',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-white shadow-[0_1px_2px_rgba(11,85,72,0.35)] hover:bg-brand-strong hover:shadow-[0_3px_10px_rgba(11,85,72,0.28)]',
        secondary: 'border border-line-strong bg-surface text-ink hover:border-[#93a39a] hover:bg-ground',
        danger: 'border border-danger bg-surface text-danger hover:bg-danger-soft',
        ghost: 'text-brand-strong hover:bg-brand-soft',
      },
    },
    defaultVariants: { variant: 'primary' },
  },
);
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button> & { loading?: boolean };

export function Button({ variant, className, loading, children, disabled, ...props }: ButtonProps) {
  return (
    <button type="button" {...props} disabled={disabled || loading} className={cn(button({ variant }), className)}>
      {loading && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
      {children}
    </button>
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

const CONTROL = 'min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-ink shadow-[inset_0_1px_1px_rgba(16,35,30,0.03)] transition-[border-color,box-shadow] duration-150 placeholder:text-muted hover:border-[#93a39a] focus:border-brand focus:outline-none focus:ring-[3px] focus:ring-brand/20';
export const Input = ({ ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) => <input ref={ref} {...props} className={cn(CONTROL, props.className)} />;
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} className={cn(CONTROL, props.className)} />;

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn('min-w-0 rounded-xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(16,35,30,0.04)]', className)}>{children}</section>;
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
  return <span className={cn('inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-semibold', TONES[tone])}>{children}</span>;
}

export function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'ok' | 'warn'; children: ReactNode }) {
  return <div role="alert" className={cn('rounded-lg px-4 py-3 font-medium', TONES[tone])}>{children}</div>;
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

/** نافذة حوار: تحبس التركيز، تُغلق بـEsc وبالضغط خارجها، وتمنع تمرير الصفحة تحتها. */
export function Dialog({ open, title, onClose, children, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-ink/45 backdrop-blur-[2px]" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className={cn('dialog-content fixed start-1/2 top-1/2 z-40 flex max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] flex-col gap-4 overflow-y-auto rounded-2xl [&>*]:shrink-0 border border-line bg-surface p-6 text-ink shadow-[0_24px_60px_-12px_rgba(16,35,30,0.35)] focus:outline-none', wide && 'w-[min(44rem,calc(100vw-2rem))]')}
        >
          <div className="flex items-start gap-3">
            <RadixDialog.Title className="min-w-0 flex-1 text-xl font-bold">{title}</RadixDialog.Title>
            <RadixDialog.Close aria-label="أغلق النافذة" className="-me-2 -mt-1 grid size-9 flex-none place-items-center rounded-full text-muted transition-colors hover:bg-ground hover:text-ink">
              <X aria-hidden="true" className="size-5" />
            </RadixDialog.Close>
          </div>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
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
  return <div aria-hidden="true" className={cn('skeleton', className)} />;
}

/** أزرار اختيار متجاورة، والمختار تنزلق تحته خلفيته. */
export function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  const id = useId();
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-xl bg-ground p-1">
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={cn('relative min-h-10 rounded-lg px-4 text-sm font-semibold transition-colors', value === v ? 'text-white' : 'text-muted hover:text-ink')}>
          {value === v && <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-lg bg-brand shadow-sm" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
          <span className="relative">{text}</span>
        </button>
      ))}
    </div>
  );
}

/** رقاقة تُضغط فتُختار، وتُضغط ثانية فتُترك. */
export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={cn('inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-all duration-150 active:scale-95', on ? 'border-brand bg-brand text-white shadow-sm' : 'border-line-strong bg-surface hover:border-brand hover:text-brand-strong')}>
      {on && <Check aria-hidden="true" className="size-3.5" />}{children}
    </button>
  );
}

/** عدد يتحرك إلى قيمته الجديدة. القيمة الحقّة في نص مخفيّ لقارئ الشاشة، فلا يقرأ أرقاماً عابرة. */
export function CountUp({ value, testId }: { value: number; testId?: string }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduce || from.current === value) { setShown(value); from.current = value; return; }
    const start = performance.now(), a = from.current, span = 320;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / span);
      setShown(Math.round(a + (value - a) * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step); else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value, reduce]);
  return (
    <>
      <span aria-hidden="true" className="tabular-nums">{shown.toLocaleString('en-US')}</span>
      <span className="sr-only" data-testid={testId}>{value}</span>
    </>
  );
}

export interface StepInfo { slug: string; title: string; hint: string }
/** شريط المراحل: ما تمّ يحمل علامته، والحالية بارزة، والخطّ بينها يمتلئ بقدر ما قُطع. تُضغط المرحلة المتاحة للانتقال إليها. */
export function Stepper({ steps, current, reachable, onGo }: { steps: StepInfo[]; current: number; reachable: number; onGo: (i: number) => void }) {
  return (
    <nav aria-label="مراحل التحضير">
      <ol className="flex items-start">
        {steps.map((s, i) => {
          const done = i < current, now = i === current, can = i <= reachable && !now;
          return (
            <li key={s.slug} className="relative flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
              {i > 0 && (
                <span aria-hidden="true" className="absolute end-1/2 top-[1.125rem] -z-0 h-0.5 w-full bg-line">
                  <motion.span className="block h-full bg-brand" initial={false} animate={{ width: i <= current ? '100%' : '0%' }} transition={{ duration: 0.35, ease: 'easeOut' }} />
                </span>
              )}
              <button type="button" disabled={!can} onClick={() => onGo(i)} aria-current={now ? 'step' : undefined} aria-label={`${i + 1}. ${s.title}${done ? ' (تمّت)' : ''}`}
                className={cn('relative z-10 grid size-9 place-items-center rounded-full border-2 text-sm font-bold transition-all duration-200',
                  now ? 'scale-110 border-brand bg-brand text-white shadow-[0_0_0_5px_rgba(15,107,92,0.14)]' : done ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface text-muted',
                  can && 'cursor-pointer hover:shadow-[0_0_0_5px_rgba(15,107,92,0.12)]')}>
                {done ? <Check aria-hidden="true" className="size-4" strokeWidth={3} /> : i + 1}
              </button>
              <span className={cn('text-sm font-semibold leading-tight', now ? 'text-brand-strong' : done ? 'text-ink' : 'text-muted')}>{s.title}</span>
              <span className="hidden text-xs text-muted lg:block">{s.hint}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
