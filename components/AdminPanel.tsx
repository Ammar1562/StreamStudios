// AdminPanel.tsx — Cross-device streaming via PeerJS signaling
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { StreamMode, VideoDevice, AudioDevice, Resolution } from '../types';

declare const Peer: any; // loaded from CDN

const PEER_PREFIX = 'ss-'; // streamstudio namespace prefix

const buildViewerUrl = (id: string) => {
  const base = window.location.origin + window.location.pathname;
  return `${base}#/viewer/${id}`;
};

const RESOLUTIONS: Resolution[] = [
  { width: 640, height: 360, label: '360p' },
  { width: 854, height: 480, label: '480p' },
  { width: 1280, height: 720, label: '720p HD' },
  { width: 1920, height: 1080, label: '1080p Full HD' },
];

const TIPS = [
  'Lighting in front of you dramatically improves video clarity.',
  'A wired connection gives the most reliable stream.',
  'Test audio before going live — bad audio loses viewers fast.',
  'Screen share with a browser tab for the smoothest capture.',
  'Use 720p for a good balance of quality and performance.',
];

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'turn:a.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const AdminPanel: React.FC = () => {
  const [streamTitle, setStreamTitle] = useState('My Live Stream');
  const [mode, setMode] = useState<StreamMode>(StreamMode.IDLE);
  const [streamUrl, setStreamUrl] = useState('');
  const [streamId, setStreamId] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [tip, setTip] = useState('');
  const [peerStatus, setPeerStatus] = useState<'idle' | 'connecting' | 'ready' | 'error'>('idle');

  const [videoDevices, setVideoDevices] = useState<VideoDevice[]>([]);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [selectedVideoDevice, setSelectedVideoDevice] = useState('');
  const [selectedAudioDevice, setSelectedAudioDevice] = useState('');
  const [selectedResolution, setSelectedResolution] = useState<Resolution>(RESOLUTIONS[2]);
  const [showDeviceMenu, setShowDeviceMenu] = useState(false);

  const [viewers, setViewers] = useState<Map<string, { id: string; joinedAt: number }>>(new Map());
  const [isFileUploading, setIsFileUploading] = useState(false);
  const [uploadFileName, setUploadFileName] = useState('');
  const [streamDuration, setStreamDuration] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<any>(null);
  const callsRef = useRef<Map<string, any>>(new Map());
  const fileVideoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const durationTimer = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const streamTitleRef = useRef(streamTitle);
  const modeRef = useRef(mode);

  useEffect(() => { streamTitleRef.current = streamTitle; }, [streamTitle]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => {
    const loadDevices = async () => {
      try {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          s.getTracks().forEach(t => t.stop());
        } catch (_) {}
        const devices = await navigator.mediaDevices.enumerateDevices();
        const vids = devices.filter(d => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
        const auds = devices.filter(d => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
        setVideoDevices(vids);
        setAudioDevices(auds);
        if (vids.length > 0) setSelectedVideoDevice(prev => prev || vids[0].deviceId);
        if (auds.length > 0) setSelectedAudioDevice(prev => prev || auds[0].deviceId);
      } catch (e) { console.warn('Device enum:', e); }
    };
    loadDevices();
    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
  }, []);

  useEffect(() => {
    if (mode !== StreamMode.IDLE) {
      startTimeRef.current = Date.now();
      durationTimer.current = window.setInterval(() => setStreamDuration(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    } else {
      if (durationTimer.current) clearInterval(durationTimer.current);
      setStreamDuration(0);
    }
    return () => { if (durationTimer.current) clearInterval(durationTimer.current); };
  }, [mode]);

  const fmtDuration = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
  };

  const destroyPeer = useCallback(() => {
    callsRef.current.forEach(call => { try { call.close(); } catch (_) {} });
    callsRef.current.clear();
    setViewers(new Map());
    if (peerRef.current) {
      try { peerRef.current.destroy(); } catch (_) {}
      peerRef.current = null;
    }
    setPeerStatus('idle');
  }, []);

  const createPeer = useCallback((id: string, stream: MediaStream) => {
    destroyPeer();
    setPeerStatus('connecting');
    const peerId = `${PEER_PREFIX}${id}`;

    const peer = new Peer(peerId, { config: { iceServers: ICE_SERVERS } });

    peer.on('open', (_pid: string) => {
      console.log('[Admin] Peer open:', _pid);
      setPeerStatus('ready');
    });

    peer.on('call', (call: any) => {
      // Answer viewer's call with our stream
      call.answer(stream);
      const vid = call.peer;
      console.log('[Admin] Viewer connected:', vid);
      setViewers(prev => { const n = new Map(prev); n.set(vid, { id: vid, joinedAt: Date.now() }); return n; });
      callsRef.current.set(vid, call);
      call.on('close', () => {
        console.log('[Admin] Viewer left:', vid);
        setViewers(prev => { const n = new Map(prev); n.delete(vid); return n; });
        callsRef.current.delete(vid);
      });
      call.on('error', (err: any) => {
        console.warn('[Admin] Call error:', err);
        callsRef.current.delete(vid);
        setViewers(prev => { const n = new Map(prev); n.delete(vid); return n; });
      });
    });

    peer.on('error', (err: any) => {
      console.error('[Admin] Peer error:', err.type, err);
      if (err.type === 'unavailable-id') {
        setError('Stream ID conflict. Please end and restart the stream.');
      } else if (err.type !== 'peer-unavailable') {
        setError(`Signaling error: ${err.type}. Check your internet connection.`);
        setPeerStatus('error');
      }
    });

    peer.on('disconnected', () => {
      setPeerStatus('connecting');
      try { peer.reconnect(); } catch (_) {}
    });

    peerRef.current = peer;
  }, [destroyPeer]);

  const setupStream = useCallback(async (stream: MediaStream, newMode: StreamMode, id: string) => {
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      try { await videoRef.current.play(); } catch (_) {}
    }
    setMode(newMode);
    setStreamId(id);
    setStreamUrl(buildViewerUrl(id));
    setTip(TIPS[Math.floor(Math.random() * TIPS.length)]);
    createPeer(id, stream);
  }, [createPeer]);

  const generateId = () => `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;

  const startCamera = async () => {
    try {
      setError('');
      const constraints: MediaStreamConstraints = {
        video: selectedVideoDevice
          ? { deviceId: { exact: selectedVideoDevice }, width: { ideal: selectedResolution.width }, height: { ideal: selectedResolution.height } }
          : { width: { ideal: selectedResolution.width }, height: { ideal: selectedResolution.height } },
        audio: selectedAudioDevice
          ? { deviceId: { exact: selectedAudioDevice }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true },
      };
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      await setupStream(stream, StreamMode.LIVE, generateId());
    } catch (e: any) { showError(e, 'Camera'); }
  };

  const startScreen = async () => {
    try {
      setError('');
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 } as any, audio: true });
      stream.getVideoTracks()[0].addEventListener('ended', () => stopStream());
      await setupStream(stream, StreamMode.SCREEN, generateId());
    } catch (e: any) {
      if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') showError(e, 'Screen Share');
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsFileUploading(true);
    setUploadFileName(file.name);
    setError('');
    try {
      if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
      if (fileVideoRef.current) {
        fileVideoRef.current.pause();
        const old = fileVideoRef.current.src;
        fileVideoRef.current.src = ''; fileVideoRef.current.remove(); fileVideoRef.current = null;
        if (old.startsWith('blob:')) URL.revokeObjectURL(old);
      }

      const videoUrl = URL.createObjectURL(file);
      const hv = document.createElement('video');
      hv.src = videoUrl; hv.loop = true; hv.muted = false; hv.playsInline = true;
      hv.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:-9999px';
      document.body.appendChild(hv);
      fileVideoRef.current = hv;

      await new Promise<void>((res, rej) => {
        hv.onloadedmetadata = () => res();
        hv.onerror = () => rej(new Error('Cannot load video file'));
        setTimeout(() => rej(new Error('Load timeout')), 15000);
      });
      await hv.play();

      const capturedStream: MediaStream | null =
        typeof (hv as any).captureStream === 'function' ? (hv as any).captureStream(30)
        : typeof (hv as any).mozCaptureStream === 'function' ? (hv as any).mozCaptureStream(30)
        : null;

      if (!capturedStream) throw new Error('captureStream() not supported. Please use Chrome or Edge.');

      if (videoRef.current) {
        videoRef.current.srcObject = null; videoRef.current.src = videoUrl;
        videoRef.current.loop = true; videoRef.current.muted = true;
        try { await videoRef.current.play(); } catch (_) {}
      }

      streamRef.current = capturedStream;
      const newId = generateId();
      setMode(StreamMode.FILE_UPLOAD);
      setStreamId(newId);
      setStreamUrl(buildViewerUrl(newId));
      setTip(TIPS[Math.floor(Math.random() * TIPS.length)]);
      createPeer(newId, capturedStream);
    } catch (err: any) {
      console.error('File upload error:', err);
      setError(`Upload failed: ${err.message}`);
    } finally {
      setIsFileUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const stopStream = useCallback(() => {
    destroyPeer();
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (fileVideoRef.current) {
      fileVideoRef.current.pause();
      const src = fileVideoRef.current.src;
      fileVideoRef.current.src = ''; fileVideoRef.current.remove(); fileVideoRef.current = null;
      if (src.startsWith('blob:')) URL.revokeObjectURL(src);
    }
    if (videoRef.current) {
      videoRef.current.pause(); videoRef.current.srcObject = null;
      videoRef.current.src = ''; videoRef.current.load();
    }
    setMode(StreamMode.IDLE); setStreamUrl(''); setStreamId('');
    setTip(''); setUploadFileName('');
  }, [destroyPeer]);

  useEffect(() => () => { stopStream(); }, [stopStream]);

  const showError = (e: any, type: string) => {
    const m: Record<string, string> = {
      NotAllowedError: `${type} permission denied.`,
      NotFoundError: `No ${type.toLowerCase()} device found.`,
      NotReadableError: `${type} is in use by another app.`,
      OverconstrainedError: `Resolution not supported on this device.`,
    };
    setError(m[e.name] || `${type}: ${e.message}`);
    setTimeout(() => setError(''), 8000);
  };

  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(streamUrl); }
    catch { const t = document.createElement('textarea'); t.value = streamUrl; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t); }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const isLive = mode !== StreamMode.IDLE;
  const viewerCount = viewers.size;
  const viewerList = Array.from(viewers.values());
  const modeLabel = () => ({ [StreamMode.LIVE]: 'Webcam', [StreamMode.SCREEN]: 'Screen', [StreamMode.FILE_UPLOAD]: 'File', [StreamMode.IDLE]: '' }[mode]);

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white">
      <header className="border-b border-white/8 px-4 sm:px-8 py-3 flex items-center justify-between sticky top-0 z-40 bg-[#0f0f0f]/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <button onClick={() => (window.location.hash = '#/')} className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center shadow-lg shadow-red-600/30">
              <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg>
            </div>
            <span className="font-black text-sm hidden sm:inline">StreamStudio</span>
          </button>
          {isLive && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-red-600/15 border border-red-500/25 rounded-full">
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full live-dot" />
              <span className="text-red-400 text-xs font-black">LIVE</span>
              <span className="text-gray-500 text-xs font-mono">{fmtDuration(streamDuration)}</span>
            </div>
          )}
          {isLive && peerStatus !== 'idle' && (
            <span className={`text-xs hidden sm:block ${peerStatus === 'ready' ? 'text-green-400' : peerStatus === 'connecting' ? 'text-yellow-400' : 'text-red-400'}`}>
              {peerStatus === 'ready' ? '● Signaling ready' : peerStatus === 'connecting' ? '○ Connecting...' : '✕ Signaling error'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isLive && (
            <>
              <span className="text-gray-500 text-sm hidden sm:block">{viewerCount} {viewerCount === 1 ? 'viewer' : 'viewers'}</span>
              <button onClick={stopStream} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-lg transition-colors">End Stream</button>
            </>
          )}
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col lg:flex-row gap-6">
        {/* Main Area */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Preview */}
          <div className="relative bg-black rounded-2xl overflow-hidden shadow-2xl" style={{ aspectRatio: '16/9' }}>
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-contain" />
            {!isLive && !isFileUploading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#0a0a0a]">
                <div className="w-20 h-20 rounded-2xl border border-white/8 flex items-center justify-center">
                  <svg className="w-9 h-9 text-white/10" fill="currentColor" viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z"/></svg>
                </div>
                <p className="text-white/20 text-sm">Select a broadcast source to begin</p>
              </div>
            )}
            {isFileUploading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90">
                <div className="w-10 h-10 border-2 border-white/10 border-t-red-500 rounded-full spin" />
                <p className="text-white/60 text-sm">Preparing stream...</p>
                <p className="text-white/30 text-xs font-mono truncate max-w-xs">{uploadFileName}</p>
              </div>
            )}
            {isLive && (
              <>
                <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
                  <div className="flex items-center gap-1.5 px-2.5 py-1 bg-red-600 rounded-md">
                    <span className="w-1.5 h-1.5 bg-white rounded-full live-dot" />
                    <span className="text-white text-xs font-black tracking-wider">LIVE</span>
                  </div>
                  <div className="px-2 py-1 bg-black/60 backdrop-blur rounded-md">
                    <span className="text-white/60 text-xs">{modeLabel()}</span>
                  </div>
                </div>
                <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5 px-2.5 py-1 bg-black/60 backdrop-blur rounded-md">
                  <svg className="w-3 h-3 text-white/50" fill="currentColor" viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                  <span className="text-white text-xs font-bold">{viewerCount}</span>
                </div>
                <div className="absolute bottom-3 left-3 right-3 z-10">
                  <p className="text-white text-sm font-bold drop-shadow truncate">{streamTitle}</p>
                </div>
              </>
            )}
          </div>

          {/* Title */}
          <div className="bg-[#1a1a1a] rounded-xl border border-white/8 p-4">
            <label className="block text-xs font-bold text-gray-600 uppercase tracking-widest mb-2.5">Stream Title</label>
            <input type="text" value={streamTitle} onChange={e => setStreamTitle(e.target.value)}
              className="w-full text-xl font-black text-white bg-transparent outline-none placeholder-gray-700 border-b border-white/8 pb-2 focus:border-red-500 transition-colors"
              placeholder="Enter stream title..." />
          </div>

          {/* Viewer Link */}
          <div className="bg-[#1a1a1a] rounded-xl border border-white/8 p-4">
            <p className="text-xs font-bold text-gray-600 uppercase tracking-widest mb-3">Viewer Link</p>
            {streamUrl ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 bg-black/50 border border-white/8 rounded-xl px-3.5 py-3">
                  <svg className="w-3.5 h-3.5 text-gray-600 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clipRule="evenodd"/></svg>
                  <span className="flex-1 text-xs text-gray-400 font-mono truncate">{streamUrl}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={handleCopy} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${copied ? 'bg-green-500/15 border border-green-500/30 text-green-400' : 'bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10'}`}>
                    {copied ? <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>Copied!</> : <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>Copy Link</>}
                  </button>
                  <button onClick={() => window.open(buildViewerUrl(streamId), '_blank', 'noopener,noreferrer')} className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold bg-red-600 hover:bg-red-700 text-white transition-colors shadow-lg shadow-red-600/20">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
                    Open Viewer
                  </button>
                </div>
                <p className="text-xs text-gray-700">Share this link with anyone on any device or browser worldwide.</p>
              </div>
            ) : (
              <div className="flex items-center justify-center h-16 border border-dashed border-white/8 rounded-xl">
                <p className="text-sm text-gray-700">Start a broadcast to generate your viewer link</p>
              </div>
            )}
          </div>

          {/* Viewers */}
          {isLive && (
            <div className="bg-[#1a1a1a] rounded-xl border border-white/8 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-bold text-gray-600 uppercase tracking-widest">Live Viewers</p>
                <span className="text-sm font-black bg-white/8 px-2.5 py-0.5 rounded-full">{viewerCount}</span>
              </div>
              {viewerCount === 0 ? (
                <p className="text-sm text-gray-700">No viewers yet — share your link!</p>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto custom-scrollbar">
                  {viewerList.map((v, i) => (
                    <div key={v.id} className="flex items-center gap-2.5 px-3 py-2 bg-white/4 rounded-lg border border-white/5">
                      <span className="w-2 h-2 bg-green-400 rounded-full flex-shrink-0" style={{ boxShadow: '0 0 6px #4ade80' }} />
                      <span className="text-sm text-gray-300 font-semibold">Viewer {i + 1}</span>
                      <span className="text-xs text-gray-700 font-mono ml-auto">{v.id.replace(PEER_PREFIX,'').slice(0,12)}&hellip;</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="w-full lg:w-72 flex-shrink-0 space-y-4">
          {/* Sources */}
          <div className="bg-[#1a1a1a] rounded-xl border border-white/8 p-4">
            <p className="text-xs font-bold text-gray-600 uppercase tracking-widest mb-3">Broadcast Source</p>
            <div className="space-y-2">
              <button onClick={startCamera} disabled={isFileUploading} className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all text-left ${mode === StreamMode.LIVE ? 'bg-blue-500/15 border-blue-500/40 text-blue-300' : 'border-white/6 hover:border-blue-500/30 hover:bg-blue-500/8 text-gray-300 disabled:opacity-40'}`}>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${mode === StreamMode.LIVE ? 'bg-blue-500/25' : 'bg-blue-500/10'}`}>
                  <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                </div>
                <div className="flex-1"><div className="text-sm font-bold">Webcam</div><div className="text-xs text-gray-600">Camera + microphone</div></div>
                {mode === StreamMode.LIVE && <span className="text-xs text-blue-400 font-black">ON</span>}
              </button>

              <button onClick={startScreen} disabled={isFileUploading} className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all text-left ${mode === StreamMode.SCREEN ? 'bg-green-500/15 border-green-500/40 text-green-300' : 'border-white/6 hover:border-green-500/30 hover:bg-green-500/8 text-gray-300 disabled:opacity-40'}`}>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${mode === StreamMode.SCREEN ? 'bg-green-500/25' : 'bg-green-500/10'}`}>
                  <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
                </div>
                <div className="flex-1"><div className="text-sm font-bold">Screen Share</div><div className="text-xs text-gray-600">Capture your display</div></div>
                {mode === StreamMode.SCREEN && <span className="text-xs text-green-400 font-black">ON</span>}
              </button>

              <label className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all text-left cursor-pointer ${mode === StreamMode.FILE_UPLOAD ? 'bg-purple-500/15 border-purple-500/40 text-purple-300' : 'border-white/6 hover:border-purple-500/30 hover:bg-purple-500/8 text-gray-300'} ${isFileUploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${mode === StreamMode.FILE_UPLOAD ? 'bg-purple-500/25' : 'bg-purple-500/10'}`}>
                  {isFileUploading ? <div className="w-4 h-4 border-2 border-purple-500/30 border-t-purple-400 rounded-full spin" /> : <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/></svg>}
                </div>
                <div className="flex-1 min-w-0"><div className="text-sm font-bold">Upload Video</div><div className="text-xs text-gray-600 truncate">{uploadFileName || 'Stream a local file'}</div></div>
                {mode === StreamMode.FILE_UPLOAD && <span className="text-xs text-purple-400 font-black">ON</span>}
                <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleFile} disabled={isFileUploading} />
              </label>
            </div>
            {isLive && <button onClick={stopStream} className="w-full mt-3 py-2.5 border border-red-500/25 bg-red-500/8 hover:bg-red-500/20 text-red-400 text-sm font-bold rounded-xl transition-all">■ End Stream</button>}
          </div>

          {/* Device Settings */}
          <div className="bg-[#1a1a1a] rounded-xl border border-white/8 p-4">
            <button onClick={() => setShowDeviceMenu(!showDeviceMenu)} className="w-full flex items-center justify-between">
              <span className="text-xs font-bold text-gray-600 uppercase tracking-widest">Device Settings</span>
              <svg className={`w-4 h-4 text-gray-700 transition-transform ${showDeviceMenu ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
            </button>
            {showDeviceMenu && (
              <div className="space-y-3 mt-4 pt-4 border-t border-white/8">
                {videoDevices.length > 0 && <div><label className="block text-xs text-gray-600 mb-1.5">Camera</label><select value={selectedVideoDevice} onChange={e => setSelectedVideoDevice(e.target.value)} className="w-full p-2.5 text-sm bg-black/40 border border-white/8 rounded-lg text-gray-300 outline-none focus:border-red-500 transition-colors">{videoDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select></div>}
                {audioDevices.length > 0 && <div><label className="block text-xs text-gray-600 mb-1.5">Microphone</label><select value={selectedAudioDevice} onChange={e => setSelectedAudioDevice(e.target.value)} className="w-full p-2.5 text-sm bg-black/40 border border-white/8 rounded-lg text-gray-300 outline-none focus:border-red-500 transition-colors">{audioDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select></div>}
                <div><label className="block text-xs text-gray-600 mb-1.5">Resolution</label><select value={selectedResolution.width} onChange={e => { const r = RESOLUTIONS.find(x => x.width === +e.target.value); if (r) setSelectedResolution(r); }} className="w-full p-2.5 text-sm bg-black/40 border border-white/8 rounded-lg text-gray-300 outline-none focus:border-red-500 transition-colors">{RESOLUTIONS.map(r => <option key={r.width} value={r.width}>{r.label}</option>)}</select></div>
              </div>
            )}
          </div>

          {/* Info */}
          <div className="bg-[#1a1a1a] rounded-xl border border-white/8 p-4 space-y-2.5">
            <p className="text-xs font-bold text-gray-600 uppercase tracking-widest">Connectivity</p>
            {[
              { icon: '🌐', text: 'Works across any device or network via PeerJS signaling' },
              { icon: '🔒', text: 'Video streams P2P — no server sees your content' },
              { icon: '📱', text: 'Viewers can watch on mobile, tablet, or desktop' },
            ].map(({ icon, text }) => (
              <div key={text} className="flex items-start gap-2.5">
                <span className="text-sm flex-shrink-0 mt-0.5">{icon}</span>
                <p className="text-xs text-gray-600 leading-relaxed">{text}</p>
              </div>
            ))}
          </div>

          {error && <div className="bg-red-900/20 border border-red-500/25 rounded-xl p-3.5 flex gap-2.5"><svg className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd"/></svg><p className="text-sm text-red-400">{error}</p></div>}
          {tip && <div className="bg-amber-900/15 border border-amber-500/20 rounded-xl p-3.5"><p className="text-xs font-bold text-amber-500 uppercase tracking-wider mb-1.5">💡 Tip</p><p className="text-sm text-amber-200/60 leading-relaxed">{tip}</p></div>}
        </div>
      </div>
    </div>
  );
};

export default AdminPanel;