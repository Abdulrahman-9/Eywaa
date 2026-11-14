import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Tone = 'ok' | 'error' | 'info';
interface Toast { id: number; tone: Tone; text: string }
const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => {});
export const useToast = () => useContext(ToastContext);

const DOT: Record<Tone, string> = { ok: 'bg-[#2F8573]', error: 'bg-[#C2453F]', info: 'bg-[#3D6FA8]' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((text: string, tone: Tone = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    // توست الخطأ يبقى حتى يُغلق باليد.
    if (tone !== 'error') setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-start gap-2">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex max-w-md items-center gap-3 rounded-[10px] bg-nav px-3.5 py-3 text-white shadow-lg">
            <span aria-hidden="true" className={`size-3 flex-none rounded-full ${DOT[t.tone]}`} />
            <span className="flex-1">{t.text}</span>
            <button type="button" aria-label="إغلاق" onClick={() => dismiss(t.id)} className="size-9 flex-none text-lg text-nav-ink">×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
