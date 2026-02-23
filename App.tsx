import React, { useState, useEffect, useCallback } from 'react';
import AdminPanel from './components/AdminPanel';
import ViewerPage from './components/ViewerPage';

const App: React.FC = () => {
  const [route, setRoute] = useState<string>(() =>
    typeof window !== 'undefined' ? window.location.hash || '#/' : '#/'
  );

  const onHashChange = useCallback(() => setRoute(window.location.hash || '#/'), []);
  useEffect(() => {
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [onHashChange]);

  if (route.startsWith('#/viewer/')) {
    const streamId = route.replace('#/viewer/', '');
    return <ViewerPage streamId={streamId} />;
  }
  if (route === '#/admin') return <AdminPanel />;

  // Home page
  return (
    <div className="min-h-screen bg-[#0f0f0f] flex items-center justify-center p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className="max-w-md w-full slide-up">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-red-600 rounded-3xl mb-6 shadow-2xl">
            <svg className="w-10 h-10 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 8l-6 4V7l6 4z"/>
            </svg>
          </div>
          <h1 className="text-4xl font-bold text-white tracking-tight">StreamStudio</h1>
          <p className="text-white/40 mt-2 text-sm">Professional live broadcasting, peer-to-peer</p>
        </div>

        <button onClick={() => { window.location.hash = '#/admin'; }}
          className="w-full py-4 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl transition-all text-base tracking-wide">
          Open Broadcast Studio
        </button>
        <p className="text-xs text-white/25 text-center mt-3">No account needed · End-to-end encrypted · Any device</p>

        <div className="grid grid-cols-3 gap-4 mt-10 pt-8 border-t border-white/10">
          {[['🔗','Private Links'],['🔒','P2P Encrypted'],['📱','Any Device']].map(([icon, label]) => (
            <div key={label} className="text-center">
              <div className="text-2xl mb-1.5">{icon}</div>
              <div className="text-xs font-medium text-white/35">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default App;
