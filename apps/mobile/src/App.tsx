import { useEffect, useState } from 'react';
import { app, getState, pendingCount, useApp } from './lib/store';
import { FirstRun, Relogin, Unlock } from './screens/Auth';
import { BoxesScreen, Custody, Donate, Requests } from './screens/Agent';
import { GrantScreen } from './screens/Grant';
import { Deliver } from './screens/Deliver';
import { Home, type Route } from './screens/Home';
import { Day, Outbox } from './screens/Lists';
import { Register } from './screens/Register';
import { StationSetup } from './screens/Station';
import { Visits } from './screens/Visits';

const AUTO_LOCK_MS = 5 * 60_000;

export function App() {
  const s = useApp();
  const [booted, setBooted] = useState(false);
  const [route, setRoute] = useState<Route>('home');

  useEffect(() => { void app.boot().then(() => setBooted(true)); }, []);

  useEffect(() => {
    // عودة الاتصال ترفع ما على الجهاز دون أن يُطلب.
    const up = () => { app.setOnline(true); if (pendingCount(getState()) > 0) void app.sync(); };
    const down = () => app.setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    // الهاتف يتنقّل بين الأيدي: يُقفل التطبيق إن غاب عن الشاشة خمس دقائق.
    let hiddenAt = 0;
    const visibility = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS && getState().unlocked) { app.lock(); setRoute('home'); }
    };
    document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(() => { if (getState().unlocked && getState().online && pendingCount(getState()) > 0) void app.sync(); }, 60_000);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); document.removeEventListener('visibilitychange', visibility); clearInterval(timer); };
  }, []);

  if (!booted) return null;
  if (!s.meta) return <FirstRun />;
  if (!s.unlocked) return <Unlock />;
  const home = () => setRoute('home');
  switch (route) {
    case 'station': return <StationSetup onBack={home} onReady={home} />;
    case 'deliver': return s.station && s.manifest ? <Deliver onBack={home} /> : s.user?.role === 'DISTRIBUTION_AGENT' ? <Home go={setRoute} /> : <StationSetup onBack={home} onReady={() => setRoute('deliver')} />;
    case 'day': return <Day onBack={home} />;
    case 'outbox': return <Outbox onBack={home} />;
    case 'register': return <Register onBack={home} onSaved={() => setRoute('outbox')} />;
    case 'grant': return <GrantScreen onBack={home} />;
    case 'visits': return <Visits onBack={home} />;
    case 'custody': return <Custody onBack={home} />;
    case 'boxes': return <BoxesScreen onBack={home} />;
    case 'donate': return <Donate onBack={home} />;
    case 'requests': return <Requests onBack={home} />;
    case 'relogin': return <Relogin onClose={home} />;
    default: return <Home go={setRoute} />;
  }
}
