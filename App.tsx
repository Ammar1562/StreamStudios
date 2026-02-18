import React, { useState, useEffect, useCallback } from 'react';
import AdminPanel from './components/AdminPanel';
import ViewerPage from './components/ViewerPage';

const App: React.FC = () => {
  const [route, setRoute] = useState<string>(window.location.hash || '#/');

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

    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6">
        <div className="max-w-md w-full text-center space-y-8">

          {/* Logo */}
          <div className="flex flex-col items-center gap-4">
            <div className="w-14 h-14 bg-black rounded-2xl flex items-center justify-center shadow-lg">
              <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h1 className="text-3xl font-bold text-gray-900 tracking-tight">StreamStudio</h1>
              <p className="text-gray-400 text-sm mt-1">Simple, secure live broadcasting</p>
            </div>
          </div>

          {/* CTA */}
          <div className="space-y-3">
            <button
              onClick={() => (window.location.hash = '#/admin')}
              className="w-full py-3.5 bg-black text-white font-semibold rounded-xl hover:bg-gray-800 transition-colors text-sm"
            >
              Open Broadcast Studio
            </button>
            <p className="text-xs text-gray-400">Viewers access via a private link — no account needed</p>
          </div>

          {/* Features */}
          <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-100">
            {[
              { icon: '🔗', label: 'Unique URL', sub: 'per session' },
              { icon: '🔒', label: 'Encrypted', sub: 'end-to-end' },
              { icon: '📡', label: 'WebRTC', sub: 'low latency' },
            ].map(f => (
              <div key={f.label} className="text-center space-y-1">
                <div className="text-2xl">{f.icon}</div>
                <div className="text-xs font-semibold text-gray-700">{f.label}</div>
                <div className="text-xs text-gray-400">{f.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return <div className="min-h-screen">{renderView()}</div>;
};

export default App;