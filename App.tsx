import React, { useState, useEffect, useCallback } from 'react';
import AdminPanel from './components/AdminPanel';
import ViewerPage from './components/ViewerPage';

const HomePage: React.FC = () => (
  <div className="min-h-screen bg-[#0f0f0f] flex items-center justify-center p-4">
    <div className="max-w-md w-full slide-up">
      {/* Logo */}
      <div className="text-center mb-10">
        <div className="inline-flex items-center justify-center w-20 h-20 bg-red-600 rounded-3xl mb-6 shadow-2xl shadow-red-900/50">
          <svg className="w-10 h-10 text-white" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 8l-6 4V7l6 4z" />
          </svg>
        </div>
        <h1 className="text-4xl font-bold text-white tracking-tight">StreamStudio</h1>
        <p className="text-white/40 mt-2 text-sm">Professional live broadcasting, peer-to-peer</p>
      </div>

      {/* CTA */}
      <div className="space-y-3">
        <button
          onClick={() => { window.location.hash = '#/admin'; }}
          className="w-full py-4 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-2xl transition-all text-base tracking-wide shadow-lg shadow-red-900/30 hover:shadow-red-900/50"
          type="button"
        >
          Open Broadcast Studio
        </button>
        <p className="text-xs text-white/25 text-center">No account needed · End-to-end encrypted · Any device</p>
      </div>

      {/* Features */}
      <div className="grid grid-cols-3 gap-4 mt-10 pt-8 border-t border-white/10">
        {[
          { icon: '🔗', label: 'Private Links' },
          { icon: '🔒', label: 'Encrypted P2P' },
          { icon: '📱', label: 'Cross-device' },
        ].map(f => (
          <div key={f.label} className="text-center">
            <div className="text-2xl mb-2">{f.icon}</div>
            <div className="text-xs font-medium text-white/40">{f.label}</div>
          </div>
        ))}
      </div>

      {/* Tech badges */}
      <div className="flex items-center justify-center gap-2 mt-8 flex-wrap">
        {['WebRTC', 'PeerJS', 'End-to-End', 'No Server Storage'].map(badge => (
          <span key={badge} className="px-2.5 py-1 bg-white/5 border border-white/10 rounded-full text-xs text-white/30 font-mono">
            {badge}
          </span>
        ))}
      </div>
    </div>
  </div>
);

const App: React.FC = () => {
  const [route, setRoute] = useState<string>(() =>
    typeof window !== 'undefined' ? window.location.hash || '#/' : '#/'
  );

  const handleHashChange = useCallback(() => {
    setRoute(window.location.hash || '#/');
  }, []);

  useEffect(() => {
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [handleHashChange]);

  const renderView = () => {
    if (route.startsWith('#/viewer/')) {
      const streamId = route.split('#/viewer/')[1];
      return <ViewerPage streamId={streamId} />;
    }
    if (route === '#/admin') {
      return <AdminPanel />;
    }
    return <HomePage />;
  };

  return <>{renderView()}</>;
};

export default App;
