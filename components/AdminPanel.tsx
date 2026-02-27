import React, { useState, useRef, useEffect, useCallback } from 'react';
import { StreamMode, VideoDevice, AudioDevice, Resolution } from '../types';

declare const Peer: any;

const PEER_PREFIX = 'ss-';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.services.mozilla.com' },
  { urls: 'turn:a.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const RESOLUTIONS: Resolution[] = [
  { width: 426,  height: 240,  label: '240p'  },
  { width: 640,  height: 360,  label: '360p'  },
  { width: 854,  height: 480,  label: '480p'  },
  { width: 1280, height: 720,  label: '720p'  },
  { width: 1920, height: 1080, label: '1080p' },
];

// ─── Icons ────────────────────────────────────────────────────────────────────
const CameraIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
  </svg>
);
const ScreenIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
  </svg>
);
const UploadIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
  </svg>
);
const CopyIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
  </svg>
);
const CheckIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
  </svg>
);
const ExternalIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
  </svg>
);
const UsersIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
  </svg>
);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const formatDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`
    : `${m}:${s.toString().padStart(2,'0')}`;
};

const generateId = () => `${Date.now().toString(36)}-${Math.random().toString(36).substring(2,8)}`;

// ─── Component ────────────────────────────────────────────────────────────────
const AdminPanel: React.FC = () => {
  const [streamTitle, setStreamTitle]       = useState('My Live Stream');
  const [mode, setMode]                     = useState<StreamMode>(StreamMode.IDLE);
  const [streamUrl, setStreamUrl]           = useState('');
  const [streamId, setStreamId]             = useState('');
  const [copied, setCopied]                 = useState(false);
  const [error, setError]                   = useState('');
  const [peerStatus, setPeerStatus]         = useState<'idle'|'connecting'|'ready'|'error'>('idle');
  const [videoDevices, setVideoDevices]     = useState<VideoDevice[]>([]);
  const [audioDevices, setAudioDevices]     = useState<AudioDevice[]>([]);
  const [selectedVideoDevice, setSelectedVideoDevice] = useState('');
  const [selectedAudioDevice, setSelectedAudioDevice] = useState('');
  const [selectedResolution, setSelectedResolution]   = useState<Resolution>(RESOLUTIONS[3]);
  const [viewers, setViewers]               = useState<Map<string,{id:string;joinedAt:number}>>(new Map());
  const [isFileLoading, setIsFileLoading]   = useState(false);
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [streamDuration, setStreamDuration] = useState(0);
  const [previewMuted, setPreviewMuted]     = useState(true);
  const [activeTab, setActiveTab]           = useState<'source'|'settings'|'share'>('source');
  const [fileDuration, setFileDuration]     = useState(0);
  const [fileCurrentTime, setFileCurrentTime] = useState(0);

  const videoRef      = useRef<HTMLVideoElement>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const peerRef       = useRef<any>(null);
  const callsRef      = useRef<Map<string,any>>(new Map());
  const fileVideoRef  = useRef<HTMLVideoElement | null>(null);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const durationTimer = useRef<number | null>(null);
  const startTimeRef  = useRef<number>(0);
  const fileTickRef   = useRef<number | null>(null);

  // ── Enumerate devices ──────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        // Request permissions first so labels are populated
        await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
          .then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
        const devices = await navigator.mediaDevices.enumerateDevices();
        const vids = devices.filter(d => d.kind === 'videoinput').map((d,i) => ({
          deviceId: d.deviceId, label: d.label || `Camera ${i+1}`
        }));
        const auds = devices.filter(d => d.kind === 'audioinput').map((d,i) => ({
          deviceId: d.deviceId, label: d.label || `Mic ${i+1}`
        }));
        setVideoDevices(vids);
        setAudioDevices(auds);
        if (vids.length) setSelectedVideoDevice(p => p || vids[0].deviceId);
        if (auds.length) setSelectedAudioDevice(p => p || auds[0].deviceId);
      } catch {}
    };
    navigator.mediaDevices.addEventListener('devicechange', load);
    load();
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, []);

  // ── Stream duration timer ──────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== StreamMode.IDLE) {
      startTimeRef.current = Date.now();
      durationTimer.current = window.setInterval(() =>
        setStreamDuration(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    } else {
      if (durationTimer.current) clearInterval(durationTimer.current);
      setStreamDuration(0);
    }
    return () => { if (durationTimer.current) clearInterval(durationTimer.current); };
  }, [mode]);

  // ── Peer management ────────────────────────────────────────────────────────
  const destroyPeer = useCallback(() => {
    callsRef.current.forEach(c => { try { c.close(); } catch {} });
    callsRef.current.clear();
    setViewers(new Map());
    if (peerRef.current) { try { peerRef.current.destroy(); } catch {}; peerRef.current = null; }
    setPeerStatus('idle');
  }, []);

  const createPeer = useCallback((id: string, stream: MediaStream) => {
    destroyPeer();
    setPeerStatus('connecting');

    const peer = new Peer(`${PEER_PREFIX}${id}`, {
      config: { iceServers: ICE_SERVERS },
    });

    peer.on('open', () => setPeerStatus('ready'));

    peer.on('call', (call: any) => {
      // Answer EVERY incoming call with our stream
      call.answer(stream);
      setViewers(prev => {
        const n = new Map(prev);
        n.set(call.peer, { id: call.peer, joinedAt: Date.now() });
        return n;
      });
      callsRef.current.set(call.peer, call);
      call.on('close', () => {
        setViewers(prev => { const n = new Map(prev); n.delete(call.peer); return n; });
        callsRef.current.delete(call.peer);
      });
      call.on('error', () => {
        setViewers(prev => { const n = new Map(prev); n.delete(call.peer); return n; });
        callsRef.current.delete(call.peer);
      });
    });

    peer.on('error', (err: any) => {
      if (err.type === 'unavailable-id') {
        setError('Stream ID conflict. Please restart.');
      } else if (err.type !== 'peer-unavailable') {
        setError(`Connection error: ${err.type}`);
        setPeerStatus('error');
      }
    });

    peer.on('disconnected', () => {
      setPeerStatus('connecting');
      try { peer.reconnect(); } catch {}
    });

    peerRef.current = peer;
  }, [destroyPeer]);

  // ── Setup stream helper ────────────────────────────────────────────────────
  const setupStream = useCallback(async (stream: MediaStream, newMode: StreamMode, id: string) => {
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true; // preview always muted (avoid feedback)
      try { await videoRef.current.play(); } catch {}
    }
    setMode(newMode);
    setStreamId(id);
    setStreamUrl(`${window.location.origin}${window.location.pathname}#/viewer/${id}`);
    createPeer(id, stream);
    setActiveTab('share');
  }, [createPeer]);

  // ── Camera ─────────────────────────────────────────────────────────────────
  const startCamera = async () => {
    try {
      setError('');
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: selectedVideoDevice
          ? { deviceId: { exact: selectedVideoDevice }, width: { ideal: selectedResolution.width }, height: { ideal: selectedResolution.height } }
          : { width: { ideal: selectedResolution.width }, height: { ideal: selectedResolution.height } },
        audio: selectedAudioDevice
          ? { deviceId: { exact: selectedAudioDevice }, echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
          : { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
      });
      await setupStream(stream, StreamMode.LIVE, generateId());
    } catch (e: any) {
      setError(e.message || 'Camera access denied');
    }
  };

  // ── Screen share ───────────────────────────────────────────────────────────
  const startScreen = async () => {
    try {
      setError('');
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks()[0].addEventListener('ended', stopStream);
      await setupStream(stream, StreamMode.SCREEN, generateId());
    } catch (e: any) {
      if (e.name !== 'NotAllowedError') setError('Screen share failed');
    }
  };

  // ── File upload ────────────────────────────────────────────────────────────
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsFileLoading(true);
    setUploadFileName(file.name);
    setUploadProgress(0);
    setError('');

    try {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      if (fileVideoRef.current) { fileVideoRef.current.pause(); fileVideoRef.current = null; }
      if (fileTickRef.current) clearInterval(fileTickRef.current);

      const videoUrl = URL.createObjectURL(file);

      // Hidden video element to decode the file
      const vid = document.createElement('video');
      vid.src = videoUrl;
      vid.playsInline = true;
      vid.loop = false;
      // IMPORTANT: video element must NOT be muted so its audio track is captured
      vid.muted = false;
      vid.volume = 1;
      vid.crossOrigin = 'anonymous';

      // Simulate progress while loading
      let prog = 0;
      const progInterval = window.setInterval(() => {
        prog = Math.min(prog + 15, 90);
        setUploadProgress(prog);
      }, 200);

      await new Promise<void>((resolve, reject) => {
        vid.onloadedmetadata = () => resolve();
        vid.onerror = () => reject(new Error('Could not load video file'));
        setTimeout(() => reject(new Error('Load timeout')), 15000);
      });

      clearInterval(progInterval);
      setUploadProgress(95);
      setFileDuration(vid.duration);

      // Play the hidden video — required so captureStream can grab audio
      await vid.play();

      // Capture stream — this includes both video + audio tracks
      // @ts-ignore
      const stream: MediaStream = vid.captureStream ? vid.captureStream(30) : vid.mozCaptureStream(30);

      // Ensure audio track is enabled
      stream.getAudioTracks().forEach(t => { t.enabled = true; });

      setUploadProgress(100);
      fileVideoRef.current = vid;

      // Tick file progress
      fileTickRef.current = window.setInterval(() => {
        setFileCurrentTime(vid.currentTime);
        if (vid.ended) {
          stopStream();
        }
      }, 500);

      // Show preview (muted to avoid echo)
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        try { await videoRef.current.play(); } catch {}
      }

      await setupStream(stream, StreamMode.FILE_UPLOAD, generateId());
    } catch (err: any) {
      setError(`Failed to load file: ${err.message}`);
    } finally {
      setIsFileLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── Stop stream ────────────────────────────────────────────────────────────
  const stopStream = useCallback(() => {
    destroyPeer();
    if (fileTickRef.current) { clearInterval(fileTickRef.current); fileTickRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (fileVideoRef.current) { fileVideoRef.current.pause(); URL.revokeObjectURL(fileVideoRef.current.src); fileVideoRef.current = null; }
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.srcObject = null; }
    setMode(StreamMode.IDLE);
    setStreamUrl('');
    setStreamId('');
    setUploadFileName('');
    setFileDuration(0);
    setFileCurrentTime(0);
    setActiveTab('source');
  }, [destroyPeer]);

  const isLive = mode !== StreamMode.IDLE;

  const copyLink = () => {
    navigator.clipboard.writeText(streamUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white flex flex-col">

      {/* ── Top bar ── */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
        <button
          onClick={() => window.location.hash = '#/'}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <div className="w-8 h-8 bg-red-600 rounded-full flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.28 6.28 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.2 8.2 0 004.79 1.52V6.76a4.85 4.85 0 01-1.02-.07z"/>
            </svg>
          </div>
          <span className="font-bold text-white text-lg hidden sm:inline">StreamStudio</span>
        </button>

        <div className="flex items-center gap-3">
          {isLive && (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-red-600/20 border border-red-600/40 rounded-full">
                <span className="w-2 h-2 bg-red-500 rounded-full live-dot flex-shrink-0" />
                <span className="text-red-400 text-xs font-semibold uppercase tracking-wide">Live</span>
                <span className="text-white/60 text-xs font-mono">{formatDuration(streamDuration)}</span>
              </div>
              <div className="flex items-center gap-1.5 text-white/60 text-sm">
                <UsersIcon />
                <span className="font-medium text-white">{viewers.size}</span>
              </div>
              <button
                onClick={stopStream}
                className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-full transition-colors"
              >
                End Stream
              </button>
            </>
          )}
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row gap-0 overflow-hidden">

        {/* ── Main preview area ── */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Video preview */}
          <div className="relative bg-black" style={{ aspectRatio: '16/9' }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted={previewMuted}
              className="w-full h-full object-contain"
            />

            {/* Idle placeholder */}
            {!isLive && !isFileLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#111] gap-4">
                <div className="w-20 h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
                  <svg className="w-10 h-10 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                  </svg>
                </div>
                <p className="text-white/40 text-sm">Choose a source to start broadcasting</p>
              </div>
            )}

            {/* File loading */}
            {isFileLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#111]/95 gap-4">
                <div className="w-48">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white/70 text-sm truncate max-w-[160px]">{uploadFileName}</span>
                    <span className="text-white/50 text-sm">{uploadProgress}%</span>
                  </div>
                  <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-red-500 rounded-full transition-all duration-300"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                  <p className="text-white/40 text-xs mt-2 text-center">Preparing video…</p>
                </div>
              </div>
            )}

            {/* Live badges */}
            {isLive && (
              <div className="absolute top-3 left-3 flex items-center gap-2">
                <span className="flex items-center gap-1.5 px-2.5 py-1 bg-red-600 rounded-md text-white text-xs font-bold">
                  <span className="w-1.5 h-1.5 bg-white rounded-full live-dot" />
                  LIVE
                </span>
                <span className="px-2 py-1 bg-black/60 backdrop-blur-sm rounded-md text-xs text-white/70 font-medium">
                  {mode === StreamMode.LIVE ? 'Camera' : mode === StreamMode.SCREEN ? 'Screen' : 'File'}
                </span>
              </div>
            )}

            {/* File progress bar on preview */}
            {mode === StreamMode.FILE_UPLOAD && fileDuration > 0 && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/10">
                <div
                  className="h-full bg-red-500 transition-all duration-500"
                  style={{ width: `${(fileCurrentTime / fileDuration) * 100}%` }}
                />
              </div>
            )}

            {/* Preview mute toggle */}
            {isLive && (
              <button
                onClick={() => setPreviewMuted(m => !m)}
                className="absolute top-3 right-3 p-2 bg-black/60 backdrop-blur-sm rounded-lg hover:bg-black/80 transition-colors"
                title={previewMuted ? 'Unmute preview' : 'Mute preview'}
              >
                {previewMuted ? (
                  <svg className="w-4 h-4 text-white/60" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 19.73L19 21 20.27 19.73 5.54 5 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                  </svg>
                ) : (
                  <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                  </svg>
                )}
              </button>
            )}
          </div>

          {/* Stream title */}
          <div className="px-4 py-3 border-b border-white/10">
            <input
              type="text"
              value={streamTitle}
              onChange={e => setStreamTitle(e.target.value)}
              className="w-full bg-transparent text-white text-lg font-semibold outline-none placeholder-white/30 focus:placeholder-white/20"
              placeholder="Stream title…"
            />
            {isLive && (
              <div className="flex items-center gap-4 mt-1">
                <span className="text-white/40 text-xs">
                  {mode === StreamMode.LIVE ? 'Camera Stream' : mode === StreamMode.SCREEN ? 'Screen Share' : `File: ${uploadFileName}`}
                </span>
                {mode === StreamMode.FILE_UPLOAD && fileDuration > 0 && (
                  <span className="text-white/40 text-xs font-mono">
                    {formatDuration(fileCurrentTime)} / {formatDuration(fileDuration)}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="mx-4 mt-3 px-4 py-3 bg-red-900/30 border border-red-700/50 rounded-xl text-red-300 text-sm flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
              </svg>
              {error}
              <button onClick={() => setError('')} className="ml-auto text-red-400/60 hover:text-red-300">✕</button>
            </div>
          )}

          {/* Viewers list (desktop bottom) */}
          {isLive && viewers.size > 0 && (
            <div className="px-4 py-3 hidden lg:block">
              <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-2">Viewers ({viewers.size})</p>
              <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto custom-scrollbar">
                {Array.from(viewers.values()).map((v, i) => (
                  <div key={v.id} className="flex items-center gap-1.5 px-2.5 py-1 bg-white/5 rounded-full">
                    <span className="w-1.5 h-1.5 bg-green-400 rounded-full" />
                    <span className="text-white/60 text-xs">Viewer {i+1}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Right sidebar ── */}
        <div className="w-full lg:w-80 xl:w-96 border-t lg:border-t-0 lg:border-l border-white/10 flex flex-col flex-shrink-0">

          {/* Tabs */}
          <div className="flex border-b border-white/10">
            {(['source','settings','share'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-3 text-xs font-semibold uppercase tracking-wider transition-colors ${
                  activeTab === tab
                    ? 'text-white border-b-2 border-red-500'
                    : 'text-white/40 hover:text-white/70'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">

            {/* ── SOURCE TAB ── */}
            {activeTab === 'source' && (
              <>
                {/* Source buttons */}
                <div>
                  <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-3">Broadcast Source</p>
                  <div className="grid grid-cols-3 gap-2">
                    {/* Camera */}
                    <button
                      onClick={startCamera}
                      disabled={isFileLoading}
                      className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${
                        mode === StreamMode.LIVE
                          ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                          : 'border-white/10 bg-white/5 text-white/60 hover:border-white/30 hover:text-white'
                      } disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      <CameraIcon />
                      <span className="text-xs font-medium">Camera</span>
                    </button>

                    {/* Screen */}
                    <button
                      onClick={startScreen}
                      disabled={isFileLoading}
                      className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${
                        mode === StreamMode.SCREEN
                          ? 'border-green-500 bg-green-500/10 text-green-400'
                          : 'border-white/10 bg-white/5 text-white/60 hover:border-white/30 hover:text-white'
                      } disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      <ScreenIcon />
                      <span className="text-xs font-medium">Screen</span>
                    </button>

                    {/* File upload */}
                    <label className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all cursor-pointer ${
                      mode === StreamMode.FILE_UPLOAD
                        ? 'border-purple-500 bg-purple-500/10 text-purple-400'
                        : 'border-white/10 bg-white/5 text-white/60 hover:border-white/30 hover:text-white'
                    } ${isFileLoading ? 'opacity-40 cursor-not-allowed' : ''}`}>
                      {isFileLoading
                        ? <div className="w-5 h-5 border-2 border-purple-400 border-t-transparent rounded-full spin" />
                        : <UploadIcon />
                      }
                      <span className="text-xs font-medium">Upload</span>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*,audio/*"
                        className="hidden"
                        onChange={handleFile}
                        disabled={isFileLoading}
                      />
                    </label>
                  </div>
                </div>

                {/* File upload info */}
                {mode === StreamMode.FILE_UPLOAD && uploadFileName && (
                  <div className="p-3 bg-purple-500/10 border border-purple-500/30 rounded-xl space-y-2">
                    <p className="text-purple-300 text-xs font-medium truncate">{uploadFileName}</p>
                    {fileDuration > 0 && (
                      <div>
                        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-purple-400 transition-all duration-500"
                            style={{ width: `${(fileCurrentTime / fileDuration) * 100}%` }}
                          />
                        </div>
                        <div className="flex justify-between mt-1">
                          <span className="text-white/40 text-xs font-mono">{formatDuration(fileCurrentTime)}</span>
                          <span className="text-white/40 text-xs font-mono">{formatDuration(fileDuration)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* End stream */}
                {isLive && (
                  <button
                    onClick={stopStream}
                    className="w-full py-2.5 bg-red-600/20 border border-red-600/40 text-red-400 hover:bg-red-600/30 rounded-xl text-sm font-semibold transition-colors"
                  >
                    End Stream
                  </button>
                )}

                {/* Connection status */}
                <div className="flex items-center gap-2 px-3 py-2 bg-white/5 rounded-lg">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    peerStatus === 'ready' ? 'bg-green-400' :
                    peerStatus === 'connecting' ? 'bg-yellow-400 live-dot' :
                    peerStatus === 'error' ? 'bg-red-400' : 'bg-white/20'
                  }`} />
                  <span className="text-white/50 text-xs">
                    {peerStatus === 'ready' ? 'Signaling ready' :
                     peerStatus === 'connecting' ? 'Connecting…' :
                     peerStatus === 'error' ? 'Connection error' : 'Not started'}
                  </span>
                </div>
              </>
            )}

            {/* ── SETTINGS TAB ── */}
            {activeTab === 'settings' && (
              <>
                {/* Resolution */}
                <div>
                  <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-3">Resolution</p>
                  <div className="grid grid-cols-5 gap-1.5">
                    {RESOLUTIONS.map(r => (
                      <button
                        key={r.label}
                        onClick={() => setSelectedResolution(r)}
                        className={`py-2 rounded-lg text-xs font-semibold transition-all ${
                          selectedResolution.label === r.label
                            ? 'bg-red-600 text-white'
                            : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white'
                        }`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Video device */}
                {videoDevices.length > 0 && (
                  <div>
                    <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-2">Camera</p>
                    <select
                      value={selectedVideoDevice}
                      onChange={e => setSelectedVideoDevice(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 text-white text-sm rounded-lg px-3 py-2 outline-none focus:border-white/30"
                    >
                      {videoDevices.map(d => (
                        <option key={d.deviceId} value={d.deviceId} className="bg-[#1a1a1a]">{d.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Audio device */}
                {audioDevices.length > 0 && (
                  <div>
                    <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-2">Microphone</p>
                    <select
                      value={selectedAudioDevice}
                      onChange={e => setSelectedAudioDevice(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 text-white text-sm rounded-lg px-3 py-2 outline-none focus:border-white/30"
                    >
                      {audioDevices.map(d => (
                        <option key={d.deviceId} value={d.deviceId} className="bg-[#1a1a1a]">{d.label}</option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}

            {/* ── SHARE TAB ── */}
            {activeTab === 'share' && (
              <>
                {streamUrl ? (
                  <>
                    <div>
                      <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-3">Viewer Link</p>
                      <div className="p-3 bg-white/5 border border-white/10 rounded-xl">
                        <p className="text-white/70 text-xs font-mono break-all">{streamUrl}</p>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={copyLink}
                        className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                          copied
                            ? 'bg-green-600/20 border border-green-600/40 text-green-400'
                            : 'bg-white/10 border border-white/10 text-white hover:bg-white/15'
                        }`}
                      >
                        {copied ? <CheckIcon /> : <CopyIcon />}
                        {copied ? 'Copied!' : 'Copy Link'}
                      </button>
                      <button
                        onClick={() => window.open(streamUrl, '_blank')}
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-semibold transition-colors"
                      >
                        <ExternalIcon />
                        Open Viewer
                      </button>
                    </div>

                    <p className="text-white/30 text-xs text-center">
                      Share this link with your audience. Works on any device.
                    </p>

                    {/* QR-like stream ID display */}
                    <div className="p-3 bg-white/5 rounded-xl text-center">
                      <p className="text-white/30 text-xs mb-1">Stream ID</p>
                      <p className="text-white font-mono text-sm tracking-wider">{streamId}</p>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center h-40 text-center">
                    <p className="text-white/30 text-sm">Start a broadcast first</p>
                    <button
                      onClick={() => setActiveTab('source')}
                      className="mt-3 text-red-400 text-sm hover:text-red-300 transition-colors"
                    >
                      Go to Source →
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminPanel;
