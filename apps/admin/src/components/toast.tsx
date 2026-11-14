import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Tone = 'ok' | 'error' | 'info';
interface Toast { id: number; tone: Tone; text: string }
const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => {});
export const useToast = () => useContext(ToastContext);

const ICON = { ok: [CheckCircle2, 'text-[#6fd3b8]'], error: [AlertCircle, 'text-[#ff9c94]'], info: [Info, 'text-[#9cc4f5]'] } as const;

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
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-start gap-2 print:hidden">
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const [Glyph, color] = ICON[t.tone];
            return (
              <motion.div key={t.id} layout role={t.tone === 'error' ? 'alert' : 'status'}
                initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl bg-nav px-3.5 py-3 text-white shadow-[0_12px_32px_-8px_rgba(16,35,30,0.55)]">
                <Glyph aria-hidden="true" className={`size-5 flex-none ${color}`} />
                <span className="flex-1">{t.text}</span>
                <button type="button" aria-label="إغلاق" onClick={() => dismiss(t.id)} className="grid size-9 flex-none place-items-center rounded-full text-nav-ink transition-colors hover:bg-white/10"><X aria-hidden="true" className="size-4" /></button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
