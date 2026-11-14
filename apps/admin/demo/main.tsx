import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App';
import { ToastProvider } from '../src/components/toast';
import { ApiError, tokenStore } from '../src/lib/api';
import { AuthProvider } from '../src/lib/auth';
import { NAV } from '../src/lib/roles';
import './demo.css';
import { DemoChrome, lastRoute } from './DemoChrome';

/*
 * نسخة العرض: اللوحة نفسها، بثلاثة فروق:
 *   1. الجلسة في الذاكرة، وتفتح مباشرة بصفة مدير النظام (demo-shim.js يجيب عن ‎/auth/me).
 *   2. التنقل في الذاكرة لا في شريط العنوان: الصفحة منشورة داخل إطار لا يملك عنوانه.
 *   3. شريط يقول إنها نسخة عرض، وزر لكتابة الملاحظات.
 */
let token: string | null = 'demo';
tokenStore.get = () => token;
tokenStore.set = (t) => { token = t; };

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 0, refetchOnWindowFocus: false, retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500) } },
});
const start = NAV.some((n) => n.to === lastRoute()) ? lastRoute() : '/';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[start]}>
        <ToastProvider>
          <AuthProvider>
            <DemoChrome><App /></DemoChrome>
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
