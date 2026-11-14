import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { NAV, ROLE_LABEL, canSee } from '../lib/roles';
import { Button, Icon } from './ui';

export function Shell() {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <div className="flex min-h-screen flex-wrap">
      <nav aria-label="القائمة الرئيسية" className="flex max-w-full flex-[1_1_15rem] flex-col gap-6 bg-nav px-4 py-6 text-nav-ink md:max-w-64">
        <div className="flex items-center gap-3 px-2">
          <div aria-hidden="true" className="flex size-10 items-center justify-center rounded-[10px] bg-brand text-white">
            <svg viewBox="0 0 24 24" className="size-6" fill="currentColor"><path d="M12 20.5s-7.5-4.6-7.5-10.4A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.5c0 5.8-7.5 10.4-7.5 10.4z" /></svg>
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-lg font-bold text-white">إيواء</span>
            <span className="text-xs text-[#A9BDB5]">إدارة المركز الإغاثي</span>
          </div>
        </div>
        <ul className="flex flex-col gap-1">
          {NAV.filter((item) => canSee(item, user.role)).map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex min-h-11 items-center gap-3 rounded-lg px-3 ${isActive ? 'bg-nav-active font-semibold text-white' : 'hover:bg-nav-active/60'}`
                }
              >
                <Icon d={item.icon} />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex min-w-0 flex-[999_1_35rem] flex-col">
        <header className="flex flex-wrap items-center justify-end gap-3 border-b border-line bg-surface px-4 py-3 md:px-8">
          <div className="flex items-center gap-3">
            <div aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-brand-soft font-bold text-brand-strong">
              {user.fullName.trim().charAt(0)}
            </div>
            <div className="flex flex-col leading-tight">
              <span className="font-semibold">{user.fullName}</span>
              <span className="text-sm text-muted">{ROLE_LABEL[user.role]}</span>
            </div>
          </div>
          <Button variant="secondary" onClick={logout}>تسجيل الخروج</Button>
        </header>
        <main className="flex flex-col gap-6 px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
