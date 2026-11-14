import { lazy, type ComponentType } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { PasswordForm, Totp } from './components/Account';
import { Shell } from './components/Shell';
import { Card, Skeleton } from './components/ui';
import { useAuth } from './lib/auth';
import { NAV, canSee } from './lib/roles';
import { Home } from './pages/Home';
import { Login } from './pages/Login';

/**
 * كل صفحة تُحمَّل عند أول دخول إليها، لا مع فتح النظام: موظف الشبّاك لا يحمّل معه المحاسبة والاستيراد والتقارير.
 * (كانت اللوحة كلها ملفاً واحداً يقارب الميغابايت.)
 */
const page = <K extends string>(load: () => Promise<{ [P in K]: ComponentType }>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const Agent = page(() => import('./pages/Agent'), 'Agent');
const Agents = page(() => import('./pages/Agents'), 'Agents');
const Audit = page(() => import('./pages/Audit'), 'Audit');
const Boxes = page(() => import('./pages/Boxes'), 'Boxes');
const FundStatement = page(() => import('./pages/FundStatement'), 'FundStatement');
const Campaign = page(() => import('./pages/Campaign'), 'Campaign');
const CampaignWizard = page(() => import('./pages/CampaignWizard'), 'CampaignWizard');
const Campaigns = page(() => import('./pages/Campaigns'), 'Campaigns');
const Cashbox = page(() => import('./pages/Cashbox'), 'Cashbox');
const Desk = page(() => import('./pages/Desk'), 'Desk');
const Families = page(() => import('./pages/Families'), 'Families');
const Family = page(() => import('./pages/Family'), 'Family');
const Import = page(() => import('./pages/Import'), 'Import');
const Inspections = page(() => import('./pages/Inspections'), 'Inspections');
const Notify = page(() => import('./pages/Notify'), 'Notify');
const Programs = page(() => import('./pages/Programs'), 'Programs');
const Register = page(() => import('./pages/Register'), 'Register');
const Reports = page(() => import('./pages/Reports'), 'Reports');
const Requests = page(() => import('./pages/Requests'), 'Requests');
const Review = page(() => import('./pages/Review'), 'Review');
const Scoring = page(() => import('./pages/Scoring'), 'Scoring');
const Housing = page(() => import('./pages/Housing'), 'Housing');
const HousingProject = page(() => import('./pages/Housing'), 'HousingProject');
const Settings = page(() => import('./pages/Settings'), 'Settings');
const Tokens = page(() => import('./pages/Tokens'), 'Tokens');
const Users = page(() => import('./pages/Users'), 'Users');
const Warehouse = page(() => import('./pages/Warehouse'), 'Warehouse');

function Message({ title, body }: { title: string; body: string }) {
  return (
    <Card className="mx-auto mt-10 flex max-w-lg flex-col gap-3 text-center">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-muted">{body}</p>
      <Link to="/" className="font-semibold text-brand-strong underline">العودة إلى الرئيسية</Link>
    </Card>
  );
}

const PAGES: Record<string, ComponentType> = {
  '/': Home, '/families': Families, '/requests': Requests, '/inspections': Inspections, '/review': Review, '/scoring': Scoring, '/programs': Programs, '/campaigns': Campaigns, '/desk': Desk, '/agents': Agents, '/boxes': Boxes, '/notify': Notify, '/warehouse': Warehouse, '/cashbox': Cashbox, '/housing': Housing, '/reports': Reports, '/users': Users, '/audit': Audit, '/settings': Settings,
};
const REGISTRARS = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'];
const FORBIDDEN = <Message title="لا صلاحية لك في هذه الصفحة" body="هذه الصفحة ليست من عمل دورك. إن رأيت أنك تحتاجها فراجع مدير النظام." />;

export function App() {
  const { user, loading, logout } = useAuth();
  if (loading) return <div className="p-8"><Skeleton className="h-8 w-64" /></div>;
  if (!user) return <Login />;
  // الكلمة المؤقتة لا يُعمل بها: تُغيَّر أولاً.
  if (user.mustChangePassword) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-bold">ضع كلمة مرورك</h1>
        <PasswordForm forced onDone={() => {}} />
      </div>
    );
  }
  // دور يملك المال أو الصلاحيات، والنشر يُلزمه بالتحقق بعاملين: يفعّله أولاً.
  if (user.totpRequired && !user.totpEnabled) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-bold">فعّل التحقق بعاملين</h1>
        <p className="text-muted">دورك يملك المال أو الصلاحيات، فلا يُفتح حسابك بكلمة المرور وحدها. نصّب على هاتفك تطبيق مصادقة (مثل Google Authenticator أو Aegis) ثم ابدأ.</p>
        <Totp bare />
        <button type="button" onClick={logout} className="min-h-11 self-start font-semibold text-muted underline">تسجيل الخروج</button>
      </div>
    );
  }
  // المتعهد يعمل من تطبيق الميدان وحده: لا شاشة له في لوحة الإدارة.
  if (user.role === 'DISTRIBUTION_AGENT') {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6 text-center">
        <h1 className="text-2xl font-bold">أهلاً {user.fullName}</h1>
        <p>عمل المتعهد من تطبيق الميدان على الهاتف: حصتك من الحملة، والتسليم، وما خُوّلتَ به.</p>
        <a href="/m/" className="inline-flex min-h-12 items-center justify-center rounded-lg bg-brand px-4 font-semibold text-white">افتح تطبيق الميدان</a>
        <button type="button" onClick={logout} className="min-h-11 font-semibold text-muted underline">تسجيل الخروج</button>
      </div>
    );
  }
  return (
    <Routes>
      <Route element={<Shell />}>
        {NAV.map((item) => {
          const Page = PAGES[item.to];
          return (
            <Route
              key={item.to}
              path={item.to}
              element={canSee(item, user.role)
                ? <Page />
                : FORBIDDEN}
            />
          );
        })}
        <Route path="/families/import" element={['ADMIN', 'BENEFICIARY_SUPERVISOR'].includes(user.role) ? <Import /> : FORBIDDEN} />
        <Route path="/families/new" element={REGISTRARS.includes(user.role) ? <Register /> : FORBIDDEN} />
        <Route path="/families/:id" element={canSee(NAV.find((n) => n.to === '/families')!, user.role) ? <Family /> : FORBIDDEN} />
        <Route path="/campaigns/new/:step?" element={['ADMIN', 'DISTRIBUTION_MANAGER'].includes(user.role) ? <CampaignWizard /> : FORBIDDEN} />
        <Route path="/campaigns/:id/edit/:step?" element={['ADMIN', 'DISTRIBUTION_MANAGER'].includes(user.role) ? <CampaignWizard /> : FORBIDDEN} />
        <Route path="/campaigns/:id" element={canSee(NAV.find((n) => n.to === '/campaigns')!, user.role) ? <Campaign /> : FORBIDDEN} />
        <Route path="/campaigns/:id/tokens" element={['ADMIN', 'DISTRIBUTION_MANAGER'].includes(user.role) ? <Tokens /> : FORBIDDEN} />
        <Route path="/agents/:id" element={canSee(NAV.find((n) => n.to === '/agents')!, user.role) ? <Agent /> : FORBIDDEN} />
        <Route path="/cashbox/funds/:id" element={canSee(NAV.find((n) => n.to === '/cashbox')!, user.role) ? <FundStatement /> : FORBIDDEN} />
        <Route path="/housing/:id" element={canSee(NAV.find((n) => n.to === '/housing')!, user.role) ? <HousingProject /> : FORBIDDEN} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Message title="الصفحة غير موجودة" body="العنوان الذي طلبته لا يقابله شيء في النظام." />} />
      </Route>
    </Routes>
  );
}
