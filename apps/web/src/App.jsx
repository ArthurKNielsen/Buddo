import { useEffect, useState, lazy, Suspense } from 'react';
import Landing from './pages/Landing.jsx';
import { BASE, href } from './lib/paths.js';

const AppShell = lazy(() => import('./pages/AppShell.jsx'));

const isApp = () => location.pathname.startsWith(BASE + 'app') || location.hash.startsWith('#/app') || window.__BUDDO_DESKTOP__;

export default function App() {
  const [app, setApp] = useState(isApp());
  useEffect(() => {
    const on = () => setApp(isApp());
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('hashchange', on);
    };
  }, []);
  if (!app) return <Landing />;
  return (
    <Suspense fallback={<div className="boot"><div className="spinner" /></div>}>
      <AppShell />
    </Suspense>
  );
}

export function navigate(path) {
  history.pushState({}, '', href(path));
  dispatchEvent(new PopStateEvent('popstate'));
}
