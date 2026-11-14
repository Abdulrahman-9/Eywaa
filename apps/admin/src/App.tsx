import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Card, Skeleton } from './components/ui';
import { useAuth } from './lib/auth';
import { NAV, canSee } from './lib/roles';
import { Audit } from './pages/Audit';
import { Families } from './pages/Families';
import { Family } from './pages/Family';
import { Register } from './pages/Register';
import { Review } from './pages/Review';
import { Scoring } from './pages/Scoring';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';

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
  '/': Home, '/families': Families, '/review': Review, '/scoring': Scoring, '/users': Users, '/audit': Audit, '/settings': Settings,
};
const REGISTRARS = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'];
const FORBIDDEN = <Message title="لا صلاحية لك في هذه الصفحة" body="هذه الصفحة ليست من عمل دورك. إن رأيت أنك تحتاجها فراجع مدير النظام." />;

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8"><Skeleton className="h-8 w-64" /></div>;
  if (!user) return <Login />;
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
        <Route path="/families/new" element={REGISTRARS.includes(user.role) ? <Register /> : FORBIDDEN} />
        <Route path="/families/:id" element={canSee(NAV.find((n) => n.to === '/families')!, user.role) ? <Family /> : FORBIDDEN} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Message title="الصفحة غير موجودة" body="العنوان الذي طلبته لا يقابله شيء في النظام." />} />
      </Route>
    </Routes>
  );
}
