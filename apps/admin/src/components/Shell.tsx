import { useQuery } from '@tanstack/react-query';
import { Component, Suspense, useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { NAV, ROLE_LABEL, canSee } from '../lib/roles';
import { AccountDialog } from './Account';
import { Alert, Button, Icon, Skeleton } from './ui';

/**
 * خطأ في صفحة لا يُسقط اللوحة كلها بياضاً: تبقى القائمة، ويُقال للموظف ما يفعل.
 * وأكثر ما يقع بعد تحديث النظام والتبويب مفتوح: ملف الصفحة القديم لم يعد في الخادم، وإعادة التحميل تجلب الجديد.
 */
class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Alert tone="warn">
        <strong>تعذّر عرض هذه الصفحة.</strong> قد يكون النظام حُدّث وهذا التبويب مفتوح. ما حفظتَه محفوظ.{' '}
        <button type="button" className="font-bold underline" onClick={() => window.location.reload()}>أعد تحميل الصفحة</button>
      </Alert>
    );
  }
}

export function Shell() {
  const { user, logout } = useAuth();
  const [account, setAccount] = useState(false);
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: () => api<{ families: { pendingApproval: number }; openDuplicateFlags: number; pendingChangeRequests: number; visitedReassessments: number }>('/stats/overview'),
    enabled: !!user,
  });
  const { pathname } = useLocation();
  // مراحل المعالج صفحة واحدة تتبدّل مرحلتها: لا يُعاد دخولها عند كل مرحلة.
  const pageKey = pathname.replace(/\/(new|edit)\/[^/]+$/, '/$1');
  // على الهاتف تنطوي القائمة خلف زر: لو بقيت مبسوطة لملأت الشاشة الأولى كلها قبل أن يظهر شيء من الصفحة.
  const [menu, setMenu] = useState(false);
  useEffect(() => { setMenu(false); }, [pathname]);
  if (!user) return null;
  const waiting = overview.data ? overview.data.families.pendingApproval + overview.data.openDuplicateFlags + overview.data.pendingChangeRequests + overview.data.visitedReassessments : 0;
  return (
    <div className="flex min-h-screen flex-wrap">
      <nav aria-label="القائمة الرئيسية" className="flex max-w-full flex-[1_1_15rem] flex-col gap-3 bg-nav px-4 py-3 text-nav-ink md:max-w-64 md:gap-6 md:py-6 print:hidden">
        <div className="flex items-center gap-3 px-2">
          <div aria-hidden="true" className="flex size-10 items-center justify-center rounded-[10px] bg-brand text-white">
            <svg viewBox="0 0 24 24" className="size-6" fill="currentColor"><path d="M12 20.5s-7.5-4.6-7.5-10.4A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.5c0 5.8-7.5 10.4-7.5 10.4z" /></svg>
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-lg font-bold text-white">إيواء</span>
            <span className="text-xs text-[#A9BDB5]">إدارة المركز الإغاثي</span>
          </div>
          <button type="button" aria-expanded={menu} aria-controls="main-menu" onClick={() => setMenu(!menu)}
            className="ms-auto min-h-11 rounded-lg border border-white/25 px-4 font-semibold text-white md:hidden">{menu ? 'أغلق القائمة' : 'القائمة'}</button>
        </div>
        <ul id="main-menu" className={`${menu ? 'flex' : 'hidden'} flex-col gap-1 md:flex`}>
          {NAV.filter((item) => canSee(item, user.role)).map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => `relative flex min-h-11 items-center gap-3 rounded-lg px-3 transition-colors ${isActive ? 'font-semibold text-white' : 'hover:bg-nav-active/60'}`}
              >
                {({ isActive }) => (
                  <>
                    {/* خلفية البند النشط تنزلق من بند إلى بند. */}
                    {isActive && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-lg bg-nav-active" transition={{ type: 'spring', stiffness: 480, damping: 40 }} />}
                    <span className="relative flex flex-1 items-center gap-3">
                      <Icon d={item.icon} />
                      <span className="flex-1">{item.label}</span>
                      {item.badge && waiting > 0 && <span className="min-w-6 rounded-full bg-[#F2C879] px-1.5 text-center text-xs font-bold text-[#3A2503]">{waiting}</span>}
                    </span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex min-w-0 flex-[999_1_35rem] flex-col">
        <header className="flex flex-wrap items-center justify-end gap-3 border-b border-line bg-surface px-4 py-3 md:px-8 print:hidden">
          <div className="flex items-center gap-3">
            <div aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-brand-soft font-bold text-brand-strong">
              {user.fullName.trim().charAt(0)}
            </div>
            <div className="flex flex-col leading-tight">
              <span className="font-semibold">{user.fullName}</span>
              <span className="text-sm text-muted">{ROLE_LABEL[user.role]}</span>
            </div>
          </div>
          <Button variant="ghost" onClick={() => setAccount(true)}>حسابي{user.totpRecommended && !user.totpEnabled ? ' ●' : ''}</Button>
          <Button variant="secondary" onClick={logout}>تسجيل الخروج</Button>
        </header>
        <main key={pageKey} className="page-in flex flex-col gap-6 px-4 py-6 md:px-8">
          <PageBoundary key={pageKey}><Suspense fallback={<Skeleton className="h-64 w-full" />}><Outlet /></Suspense></PageBoundary>
        </main>
        <AccountDialog open={account} onClose={() => setAccount(false)} />
      </div>
    </div>
  );
}
