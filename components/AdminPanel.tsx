import React, { useState, useRef, useEffect, useCallback } from 'react';
import { StreamMode, VideoDevice, AudioDevice, Resolution } from '../types';

declare const Peer: any;

const PEER_PREFIX = 'ss-';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'turn:a.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const RESOLUTIONS: Resolution[] = [
  { width: 426, height: 240, label: '240p' },
  { width: 640, height: 360, label: '360p' },
  { width: 854, height: 480, label: '480p' },
  { width: 1280, height: 720, label: '720p HD' },
  { width: 1920, height: 1080, label: '1080p Full HD' },
];

const AdminPanel: React.FC = () => {
  const [streamTitle, setStreamTitle] = useState('My Live Stream');
  const [mode, setMode] = useState<StreamMode>(StreamMode.IDLE);
  const [streamUrl, setStreamUrl] = useState('');
  const [streamId, setStreamId] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
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
  // Separate state for preview audio (local mute) - default to muted to prevent feedback
  const [isPreviewMuted, setIsPreviewMuted] = useState(true);
  // Track if stream actually has audio
  const [hasAudio, setHasAudio] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<any>(null);
  const callsRef = useRef<Map<string, any>>(new Map());
  const fileVideoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const durationTimer = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const vids = devices.filter(d => d.kind === 'videoinput').map((d, i) => ({ 
          deviceId: d.deviceId, 
          label: d.label || `Camera ${i + 1}` 
        }));
        const auds = devices.filter(d => d.kind === 'audioinput').map((d, i) => ({ 
          deviceId: d.deviceId, 
          label: d.label || `Microphone ${i + 1}` 
        }));
        setVideoDevices(vids);
        setAudioDevices(auds);
        if (vids.length > 0) setSelectedVideoDevice(prev => prev || vids[0].deviceId);
        if (auds.length > 0) setSelectedAudioDevice(prev => prev || auds[0].deviceId);
      } catch (e) { console.warn('Device enum:', e); }
    };
    
    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    loadDevices();
    return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
  }, []);

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

  const destroyPeer = useCallback(() => {
    callsRef.current.forEach(call => { try { call.close(); } catch {} });
    callsRef.current.clear();
    setViewers(new Map());
    if (peerRef.current) {
      try { peerRef.current.destroy(); } catch {}
      peerRef.current = null;
    }
    setPeerStatus('idle');
  }, []);

  const createPeer = useCallback((id: string, stream: MediaStream) => {
    destroyPeer();
    setPeerStatus('connecting');
    const peerId = `${PEER_PREFIX}${id}`;

    const peer = new Peer(peerId, { config: { iceServers: ICE_SERVERS } });

    peer.on('open', () => setPeerStatus('ready'));
    peer.on('call', (call: any) => {
      // Answer with the actual stream (which has audio)
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
    });

    peer.on('error', (err: any) => {
      if (err.type === 'unavailable-id') {
        setError('Stream ID conflict. Please restart.');
      } else if (err.type !== 'peer-unavailable') {
        setError(`Signaling error: ${err.type}`);
        setPeerStatus('error');
      }
    });

    peer.on('disconnected', () => {
      setPeerStatus('connecting');
      try { peer.reconnect(); } catch {}
    });

    peerRef.current = peer;
  }, [destroyPeer]);

  const setupStream = useCallback(async (stream: MediaStream, newMode: StreamMode, id: string) => {
    streamRef.current = stream;
    
    // Check if stream has audio tracks
    const audioTracks = stream.getAudioTracks();
    setHasAudio(audioTracks.length > 0);
    
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      // Mute preview locally to prevent feedback, but stream still has audio
      videoRef.current.muted = isPreviewMuted;
      try { await videoRef.current.play(); } catch {}
    }
    setMode(newMode);
    setStreamId(id);
    setStreamUrl(`${window.location.origin}${window.location.pathname}#/viewer/${id}`);
    createPeer(id, stream);
  }, [createPeer, isPreviewMuted]);

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
    } catch (e: any) {
      setError(e.message || 'Camera access failed');
    }
  };

  const startScreen = async () => {
    try {
      setError('');
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks()[0].addEventListener('ended', () => stopStream());
      await setupStream(stream, StreamMode.SCREEN, generateId());
    } catch (e: any) {
      if (e.name !== 'NotAllowedError') setError('Screen share cancelled');
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsFileUploading(true);
    setUploadFileName(file.name);
    
    try {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      
      const videoUrl = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.src = videoUrl;
      video.loop = true;
      video.muted = false; // Keep audio for streaming
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = reject;
        setTimeout(() => reject(new Error('Load timeout')), 10000);
      });
      
      await video.play();
      
      // @ts-ignore - captureStream exists in modern browsers
      const stream = video.captureStream(30);
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Mute preview locally
        videoRef.current.muted = isPreviewMuted;
        await videoRef.current.play();
      }
      
      fileVideoRef.current = video;
      await setupStream(stream, StreamMode.FILE_UPLOAD, generateId());
    } catch (err: any) {
      setError(`Upload failed: ${err.message}`);
    } finally {
      setIsFileUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const stopStream = useCallback(() => {
    destroyPeer();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (fileVideoRef.current) {
      fileVideoRef.current.pause();
      fileVideoRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    setMode(StreamMode.IDLE);
    setStreamUrl('');
    setStreamId('');
    setUploadFileName('');
    setHasAudio(false);
  }, [destroyPeer]);

  // Toggle preview audio (local mute only - doesn't affect stream)
  const togglePreviewAudio = () => {
    if (videoRef.current) {
      const newMutedState = !videoRef.current.muted;
      videoRef.current.muted = newMutedState;
      setIsPreviewMuted(newMutedState);
    }
  };

  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
  };

  const isLive = mode !== StreamMode.IDLE;

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => window.location.hash = '#/'} 
              className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            >
              <div className="w-8 h-8 bg-gray-900 rounded-full flex items-center justify-center">
                <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
              <span className="font-semibold text-gray-900 hidden sm:inline">StreamStudios</span>
            </button>
            
            {isLive && (
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 px-2 py-1 bg-red-50 rounded-md">
                  <span className="w-2 h-2 bg-red-500 rounded-full live-dot" />
                  <span className="text-red-600 text-xs font-medium">LIVE</span>
                </span>
                <span className="text-gray-400 text-xs font-mono">{formatDuration(streamDuration)}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isLive && (
              <>
                <span className="text-sm text-gray-600 hidden sm:block">
                  {viewers.size} viewer{viewers.size !== 1 ? 's' : ''}
                </span>
                <button
                  onClick={stopStream}
                  className="px-4 py-1.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  End
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-2 sm:px-2 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content - 2/3 width on desktop */}
          <div className="lg:col-span-2 space-y-4">
            {/* Video Preview */}
            <div className="bg-gray-50 rounded-xl overflow-hidden border border-gray-200">
              <div className="relative bg-black" style={{ aspectRatio: '16/9' }}>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted={isPreviewMuted} // This only affects local preview
                  className="w-full h-full object-contain"
                />
                
                {!isLive && !isFileUploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
                    <div className="text-center">
                      <div className="w-16 h-16 mx-auto mb-3 rounded-2xl bg-gray-800 flex items-center justify-center">
                        <svg className="w-8 h-8 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <p className="text-gray-400 text-sm">Select a source to start broadcasting</p>
                    </div>
                  </div>
                )}

                {isFileUploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-900/90">
                    <div className="text-center">
                      <div className="w-10 h-10 border-2 border-gray-600 border-t-blue-500 rounded-full spin mx-auto mb-3" />
                      <p className="text-gray-300 text-sm">Preparing stream...</p>
                      <p className="text-gray-500 text-xs mt-1">{uploadFileName}</p>
                    </div>
                  </div>
                )}

                {/* Editable stream title overlay */}
                <div className="absolute bottom-3 left-3 right-3">
                  <input
                    type="text"
                    value={streamTitle}
                    onChange={e => setStreamTitle(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-medium text-white bg-black/50 backdrop-blur-sm rounded-lg outline-none focus:bg-black/75 transition-colors"
                    placeholder="Enter stream title..."
                  />
                </div>

                {isLive && (
                  <>
                    <div className="absolute top-3 left-3 flex items-center gap-2">
                      <span className="flex items-center gap-1.5 px-2 py-1 bg-red-500 rounded-md">
                        <span className="w-1.5 h-1.5 bg-white rounded-full live-dot" />
                        <span className="text-white text-xs font-medium">LIVE</span>
                      </span>
                      <span className="px-2 py-1 bg-gray-900/75 backdrop-blur-sm rounded-md text-xs text-gray-300">
                        {mode === StreamMode.LIVE ? 'Camera' : mode === StreamMode.SCREEN ? 'Screen' : 'File'}
                      </span>
                      {hasAudio && (
                        <span className="px-2 py-1 bg-gray-900/75 backdrop-blur-sm rounded-md text-xs text-gray-300">
                          Audio Available
                        </span>
                      )}
                    </div>

                    {/* Audio toggle for preview only - doesn't affect stream */}
                    {hasAudio && (
                      <button
                        onClick={togglePreviewAudio}
                        className="absolute top-3 right-3 p-2 bg-gray-900/75 backdrop-blur-sm rounded-lg hover:bg-gray-900 transition-colors"
                        title={isPreviewMuted ? 'Unmute preview (local only)' : 'Mute preview (local only)'}
                      >
                        {isPreviewMuted ? (
                          <svg className="w-4 h-4 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                          </svg>
                        )}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Stream Link */}
            <div className="bg-white border border-gray-200 rounded-xl p-2">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                Viewer Link
              </p>
              
              {streamUrl ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5">
                    <svg className="w-4 h-4 text-gray-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                    <span className="flex-1 text-xs text-gray-600 font-mono truncate">{streamUrl}</span>
                  </div>
                  
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(streamUrl);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        copied 
                          ? 'bg-green-50 text-green-600 border border-green-200' 
                          : 'bg-gray-50 text-gray-700 border border-gray-200 hover:bg-gray-100'
                      }`}
                    >
                      {copied ? (
                        <>
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          Copied!
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          Copy Link
                        </>
                      )}
                    </button>
                    
                    <button
                      onClick={() => window.open(streamUrl, '_blank')}
                      className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      Open Viewer
                    </button>
                  </div>
                  
                  <p className="text-xs text-gray-400">
                    Share this link with viewers. Each stream has a unique URL.
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-center h-16 border border-dashed border-gray-200 rounded-lg">
                  <p className="text-sm text-gray-400">Start a broadcast to generate your link</p>
                </div>
              )}
            </div>

            {/* Viewers List */}
            {isLive && (
              <div className="bg-white border border-gray-200 rounded-xl p-2">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Live Viewers
                  </p>
                  <span className="text-xs font-medium bg-gray-100 px-2 py-0.5 rounded-full">
                    {viewers.size}
                  </span>
                </div>
                
                {viewers.size === 0 ? (
                  <p className="text-sm text-gray-400">No viewers yet — share your link!</p>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                    {Array.from(viewers.values()).map((viewer, i) => (
                      <div key={viewer.id} className="flex items-center gap-3 px-3 py-2 bg-gray-50 rounded-lg">
                        <span className="w-2 h-2 bg-green-500 rounded-full" />
                        <span className="text-sm text-gray-700 font-medium">Viewer {i + 1}</span>
                        <span className="text-xs text-gray-400 font-mono ml-auto">
                          {viewer.id.replace(PEER_PREFIX, '').slice(0, 8)}…
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sidebar - 1/3 width on desktop */}
          <div className="space-y-2">
            {/* Source Selection */}
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                Broadcast Source
              </p>
              
              <div className="flex gap-2">
                <button
                  onClick={startCamera}
                  disabled={isFileUploading}
                  className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border transition-all ${
                    mode === StreamMode.LIVE
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300 bg-white'
                  } ${isFileUploading ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className={`w-8 h-8 rounded-md flex items-center justify-center ${
                    mode === StreamMode.LIVE ? 'bg-blue-500' : 'bg-gray-100'
                  }`}>
                    <svg className={`w-4 h-4 ${
                      mode === StreamMode.LIVE ? 'text-white' : 'text-gray-600'
                    }`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <span className="text-sm font-medium text-gray-900">Camera</span>
                </button>

                <button
                  onClick={startScreen}
                  disabled={isFileUploading}
                  className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border transition-all ${
                    mode === StreamMode.SCREEN
                      ? 'border-green-500 bg-green-50'
                      : 'border-gray-200 hover:border-gray-300 bg-white'
                  } ${isFileUploading ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className={`w-8 h-8 rounded-md flex items-center justify-center ${
                    mode === StreamMode.SCREEN ? 'bg-green-500' : 'bg-gray-100'
                  }`}>
                    <svg className={`w-4 h-4 ${
                      mode === StreamMode.SCREEN ? 'text-white' : 'text-gray-600'
                    }`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <span className="text-sm font-medium text-gray-900">Screen</span>
                </button>

                <label className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border transition-all cursor-pointer ${
                  mode === StreamMode.FILE_UPLOAD
                    ? 'border-purple-500 bg-purple-50'
                    : 'border-gray-200 hover:border-gray-300 bg-white'
                } ${isFileUploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
                  <div className={`w-8 h-8 rounded-md flex items-center justify-center ${
                    mode === StreamMode.FILE_UPLOAD ? 'bg-purple-500' : 'bg-gray-100'
                  }`}>
                    {isFileUploading ? (
                      <div className="w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full spin" />
                    ) : (
                      <svg className={`w-4 h-4 ${
                        mode === StreamMode.FILE_UPLOAD ? 'text-white' : 'text-gray-600'
                      }`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                    )}
                  </div>
                  <span className="text-sm font-medium text-gray-900">Upload</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={handleFile}
                    disabled={isFileUploading}
                  />
                </label>
              </div>

              {isLive && (
                <button
                  onClick={stopStream}
                  className="w-full mt-3 py-2.5 bg-red-50 text-red-600 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors"
                >
                  End Stream
                </button>
              )}
            </div>

            {/* Device Settings */}
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <button
                onClick={() => setShowDeviceMenu(!showDeviceMenu)}
                className="w-full flex items-center justify-between"
              >
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Device Settings
                </span>
                <svg
                  className={`w-4 h-4 text-gray-400 transition-transform ${
                    showDeviceMenu ? 'rotate-180' : ''
                  }`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {showDeviceMenu && (
                <div className="space-y-4 mt-4 pt-4 border-t border-gray-200">
                  {videoDevices.length > 0 && (
                    <div>
                      <label className="block text-xs text-gray-600 mb-2 font-medium">Camera</label>
                      <select
                        value={selectedVideoDevice}
                        onChange={e => setSelectedVideoDevice(e.target.value)}
                        className="w-full p-3 text-sm bg-white border border-gray-300 rounded-lg text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all"
                      >
                        {videoDevices.map(d => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {audioDevices.length > 0 && (
                    <div>
                      <label className="block text-xs text-gray-600 mb-2 font-medium">Microphone</label>
                      <select
                        value={selectedAudioDevice}
                        onChange={e => setSelectedAudioDevice(e.target.value)}
                        className="w-full p-3 text-sm bg-white border border-gray-300 rounded-lg text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all"
                      >
                        {audioDevices.map(d => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs text-gray-600 mb-2 font-medium">Resolution</label>
                    <select
                      value={selectedResolution.width}
                      onChange={e => {
                        const res = RESOLUTIONS.find(r => r.width === Number(e.target.value));
                        if (res) setSelectedResolution(res);
                      }}
                      className="w-full p-3 text-sm bg-white border border-gray-300 rounded-lg text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all"
                    >
                      {RESOLUTIONS.map(r => (
                        <option key={r.width} value={r.width} selected={r.width === 1920}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Info Card */}
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                How it works
              </p>
              <div className="space-y-2.5">
                <div className="flex items-start gap-2.5">
                  <span className="text-sm">🌐</span>
                  <p className="text-xs text-gray-600">Works across any device via WebRTC</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="text-sm">🔒</span>
                  <p className="text-xs text-gray-600">Peer-to-peer encrypted streaming</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="text-sm">📱</span>
                  <p className="text-xs text-gray-600">Viewers can watch on mobile or desktop</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="text-sm">🔊</span>
                  <p className="text-xs text-gray-600">Audio is always enabled for viewers</p>
                </div>
              </div>
            </div>

            {/* Error Message */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminPanel;
