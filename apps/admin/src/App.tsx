import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { PasswordForm } from './components/Account';
import { Shell } from './components/Shell';
import { Card, Skeleton } from './components/ui';
import { useAuth } from './lib/auth';
import { NAV, canSee } from './lib/roles';
import { Audit } from './pages/Audit';
import { Campaign } from './pages/Campaign';
import { CampaignNew } from './pages/CampaignNew';
import { Campaigns } from './pages/Campaigns';
import { Cashbox } from './pages/Cashbox';
import { Desk } from './pages/Desk';
import { Families } from './pages/Families';
import { Family } from './pages/Family';
import { Import } from './pages/Import';
import { Notify } from './pages/Notify';
import { Programs } from './pages/Programs';
import { Register } from './pages/Register';
import { Reports } from './pages/Reports';
import { Requests } from './pages/Requests';
import { Review } from './pages/Review';
import { Scoring } from './pages/Scoring';
import { Housing, HousingProject } from './pages/Housing';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { Tokens } from './pages/Tokens';
import { Users } from './pages/Users';
import { Warehouse } from './pages/Warehouse';

function Message({ title, body }: { title: string; body: string }) {
  return (
    <Card className="mx-auto mt-10 flex max-w-lg flex-col gap-3 text-center">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-muted">{body}</p>
      <Link to="/" className="font-semibold text-brand-strong underline">العودة إلى الرئيسية</Link>
    </Card>
  );
}

const PAGES: Record<string, () => React.JSX.Element> = {
  '/': Home, '/families': Families, '/requests': Requests, '/review': Review, '/scoring': Scoring, '/programs': Programs, '/campaigns': Campaigns, '/desk': Desk, '/notify': Notify, '/warehouse': Warehouse, '/cashbox': Cashbox, '/housing': Housing, '/reports': Reports, '/users': Users, '/audit': Audit, '/settings': Settings,
};
const REGISTRARS = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'];
const FORBIDDEN = <Message title="لا صلاحية لك في هذه الصفحة" body="هذه الصفحة ليست من عمل دورك. إن رأيت أنك تحتاجها فراجع مدير النظام." />;

export function App() {
  const { user, loading } = useAuth();
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
        <Route path="/campaigns/new" element={['ADMIN', 'DISTRIBUTION_MANAGER'].includes(user.role) ? <CampaignNew /> : FORBIDDEN} />
        <Route path="/campaigns/:id" element={canSee(NAV.find((n) => n.to === '/campaigns')!, user.role) ? <Campaign /> : FORBIDDEN} />
        <Route path="/campaigns/:id/tokens" element={['ADMIN', 'DISTRIBUTION_MANAGER'].includes(user.role) ? <Tokens /> : FORBIDDEN} />
        <Route path="/housing/:id" element={canSee(NAV.find((n) => n.to === '/housing')!, user.role) ? <HousingProject /> : FORBIDDEN} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Message title="الصفحة غير موجودة" body="العنوان الذي طلبته لا يقابله شيء في النظام." />} />
      </Route>
    </Routes>
  );
}
