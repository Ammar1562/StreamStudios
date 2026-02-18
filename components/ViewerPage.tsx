// ViewerPage.tsx — Cross-device viewer using PeerJS
import React, { useEffect, useState, useRef, useCallback } from 'react';

declare const Peer: any; // loaded from CDN

interface ViewerPageProps {
  streamId: string;
}

const PEER_PREFIX = 'ss-';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'turn:a.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
};

const ViewerPage: React.FC<ViewerPageProps> = ({ streamId }) => {
  const [status, setStatus] = useState<'connecting' | 'live' | 'ended'>('connecting');
  const [streamTitle, setStreamTitle] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [connectionAttempts, setConnectionAttempts] = useState(0);

  // Player state
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [showVolume, setShowVolume] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [pip, setPip] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isLiveStream, setIsLiveStream] = useState(true);
  const [hasVideo, setHasVideo] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<any>(null);
  const callRef = useRef<any>(null);
  const playPromiseRef = useRef<Promise<void> | null>(null);
  const controlsTimer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const isConnectingRef = useRef(false); // prevent overlapping connect attempts
  const mountedRef = useRef(true);

  // Mutable viewer ID — regenerated on each fresh Peer creation to avoid "unavailable-id"
  const viewerIdRef = useRef(`v-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`);
  const genViewerId = () => {
    viewerIdRef.current = `v-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
    return viewerIdRef.current;
  };

  const adminPeerId = `${PEER_PREFIX}${streamId}`;

  const safePlay = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return false;
    try {
      if (playPromiseRef.current) { await playPromiseRef.current.catch(() => {}); playPromiseRef.current = null; }
      if (v.paused) {
        playPromiseRef.current = v.play();
        await playPromiseRef.current;
        setPlaying(true); return true;
      }
      return true;
    } catch (e: any) {
      if (e.name !== 'AbortError') console.warn('Play:', e.name);
      return false;
    } finally { playPromiseRef.current = null; }
  }, []);

  const safePause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    try { v.pause(); setPlaying(false); } catch (_) {}
  }, []);

  const togglePlay = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) await safePlay(); else safePause();
  }, [safePlay, safePause]);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const changeVolume = useCallback((val: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = val; v.muted = val === 0;
    setVolume(val); setMuted(val === 0);
  }, []);

  const changePlaybackRate = useCallback((rate: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = rate; setPlaybackRate(rate); setShowSettings(false);
  }, []);

  const seek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v || !duration || isLiveStream) return;
    v.currentTime = parseFloat(e.target.value);
  }, [duration, isLiveStream]);

  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    try {
      if (!document.fullscreenElement) await containerRef.current.requestFullscreen();
      else await document.exitFullscreen();
    } catch (_) {}
  }, []);

  const togglePip = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) { await document.exitPictureInPicture(); setPip(false); }
      else { await v.requestPictureInPicture(); setPip(true); }
    } catch (_) {}
  }, []);

  const resetControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = window.setTimeout(() => {
      setShowControls(false); setShowVolume(false); setShowSettings(false);
    }, 3000);
  }, []);

  // Destroy existing peer cleanly
  const destroyPeer = useCallback(() => {
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    if (callRef.current) { try { callRef.current.close(); } catch (_) {} callRef.current = null; }
    if (peerRef.current) { try { peerRef.current.destroy(); } catch (_) {} peerRef.current = null; }
    isConnectingRef.current = false;
  }, []);

  const attemptCall = useCallback((peer: any) => {
    if (!peer || peer.destroyed || !mountedRef.current) return;
    if (callRef.current) { try { callRef.current.close(); } catch (_) {} callRef.current = null; }

    // PeerJS caller must send a stream — send a tiny silent canvas stream
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    const ctx = canvas.getContext('2d');
    if (ctx) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 2, 2); }
    const dummyStream = canvas.captureStream(1);

    console.log('[Viewer] Calling admin:', adminPeerId);
    let call: any;
    try { call = peer.call(adminPeerId, dummyStream); } catch (e) {
      console.warn('[Viewer] call() threw:', e);
      return;
    }
    if (!call) { console.warn('[Viewer] call() returned null'); return; }
    callRef.current = call;

    call.on('stream', (remoteStream: MediaStream) => {
      if (!mountedRef.current) return;
      console.log('[Viewer] Got stream, tracks:', remoteStream.getTracks().length);
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = remoteStream;
      setHasVideo(true); setStatus('live'); setIsBuffering(false); setIsLiveStream(true);
      safePlay().then(ok => { if (!ok) setPlaying(false); });
    });

    call.on('close', () => {
      if (!mountedRef.current) return;
      console.log('[Viewer] Call closed');
      setStatus('ended'); setErrorMsg('The broadcast has ended.'); setHasVideo(false);
      if (videoRef.current) videoRef.current.srcObject = null;
    });

    call.on('error', (err: any) => {
      console.warn('[Viewer] Call error:', err);
      if (!mountedRef.current) return;
      setConnectionAttempts(a => a + 1);
    });
  }, [adminPeerId, safePlay]);

  // Connect to the admin peer — always creates a fresh Peer with a fresh ID
  const connectToBroadcaster = useCallback(() => {
    if (!mountedRef.current) return;
    if (isConnectingRef.current) return; // prevent concurrent attempts
    isConnectingRef.current = true;

    destroyPeer();

    const myId = genViewerId();
    console.log('[Viewer] Creating peer with ID:', myId);

    let peer: any;
    try {
      peer = new Peer(myId, { config: { iceServers: ICE_SERVERS } });
    } catch (e) {
      console.error('[Viewer] Peer constructor failed:', e);
      isConnectingRef.current = false;
      return;
    }
    peerRef.current = peer;

    peer.on('open', (_id: string) => {
      console.log('[Viewer] Peer open:', _id);
      isConnectingRef.current = false;
      attemptCall(peer);
    });

    peer.on('error', (err: any) => {
      console.log('[Viewer] Peer error:', err.type);
      if (!mountedRef.current) return;
      isConnectingRef.current = false;

      if (err.type === 'unavailable-id') {
        // This ID is taken on the signaling server — create a fresh peer with a new ID
        console.log('[Viewer] ID collision, retrying with new ID in 1s...');
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => {
          if (mountedRef.current) connectToBroadcaster();
        }, 1000);

      } else if (err.type === 'peer-unavailable') {
        // Admin not live yet — keep retrying with the SAME peer (don't recreate)
        console.log('[Viewer] Admin not found, retrying call in 3s...');
        setConnectionAttempts(a => a + 1);
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => {
          if (mountedRef.current && peerRef.current && !peerRef.current.destroyed && !peerRef.current.disconnected) {
            attemptCall(peerRef.current);
          } else if (mountedRef.current) {
            connectToBroadcaster();
          }
        }, 3000);

      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
        // Transient network issue — retry fresh
        console.log('[Viewer] Network error, reconnecting in 4s...');
        setConnectionAttempts(a => a + 1);
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => {
          if (mountedRef.current) connectToBroadcaster();
        }, 4000);

      } else {
        console.error('[Viewer] Unhandled error type:', err.type, err);
        setConnectionAttempts(a => a + 1);
        // Still retry after a delay
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => {
          if (mountedRef.current) connectToBroadcaster();
        }, 5000);
      }
    });

    // On signaling server disconnect: do NOT call peer.reconnect() — it reuses the same ID
    // and can collide. Instead destroy and create fresh after a delay.
    peer.on('disconnected', () => {
      console.log('[Viewer] Signaling disconnected');
      if (!mountedRef.current) return;
      // Only reconnect if not already destroyed and we haven't been told stream ended
      if (peer && !peer.destroyed) {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => {
          if (mountedRef.current) connectToBroadcaster();
        }, 3000);
      }
    });
  }, [destroyPeer, attemptCall]);

  // Init peer connection
  useEffect(() => {
    mountedRef.current = true;
    connectToBroadcaster();
    resetControls();

    const onFSChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFSChange);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('fullscreenchange', onFSChange);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
      destroyPeer();
    };
  }, [connectToBroadcaster, resetControls, destroyPeer]);

  // Video event listeners
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTimeUpdate = () => setCurrentTime(v.currentTime);
    const onLoadedMetadata = () => {
      const dur = v.duration || 0;
      setDuration(dur);
      // Finite, reasonable duration = file upload. Infinite/NaN = live.
      setIsLiveStream(!isFinite(dur) || dur > 86400 || dur === 0);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVolumeChange = () => { setMuted(v.muted); setVolume(v.volume); };
    const onProgress = () => { if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1)); };
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => setIsBuffering(false);
    const onEnded = () => { if (!isLiveStream) setPlaying(false); };
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('loadedmetadata', onLoadedMetadata);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('volumechange', onVolumeChange);
    v.addEventListener('progress', onProgress);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('loadedmetadata', onLoadedMetadata);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('volumechange', onVolumeChange);
      v.removeEventListener('progress', onProgress);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('ended', onEnded);
    };
  }, [isLiveStream]);

  const volPct = (muted ? 0 : volume) * 100;
  const seekPct = duration ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration ? (buffered / duration) * 100 : 0;

  if (status === 'ended') {
    return (
      <div className="min-h-screen bg-[#0f0f0f] flex items-center justify-center p-6">
        <div className="text-center space-y-5 max-w-sm">
          <div className="w-20 h-20 bg-[#1a1a1a] rounded-2xl flex items-center justify-center mx-auto border border-white/8">
            <svg className="w-9 h-9 text-gray-600" fill="currentColor" viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z"/></svg>
          </div>
          <div>
            <h2 className="text-2xl font-black text-white">Stream Ended</h2>
            <p className="text-gray-500 text-sm mt-2">{errorMsg}</p>
          </div>
          <button onClick={() => (window.location.hash = '#/')} className="px-8 py-3 bg-[#1a1a1a] hover:bg-[#252525] border border-white/10 text-white rounded-xl font-semibold text-sm transition-colors">
            Go Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0f0f0f] flex flex-col">
      {/* Player */}
      <div
        ref={containerRef}
        className={`relative bg-black ${fullscreen ? 'fixed inset-0 z-50' : 'w-full'}`}
        style={!fullscreen ? { aspectRatio: '16/9' } : {}}
        onMouseMove={resetControls}
        onMouseLeave={() => {
          if (controlsTimer.current) clearTimeout(controlsTimer.current);
          controlsTimer.current = window.setTimeout(() => { setShowControls(false); setShowVolume(false); setShowSettings(false); }, 1000);
        }}
      >
        {/* Video */}
        <video
          ref={videoRef}
          className="w-full h-full object-contain bg-black"
          playsInline
          onClick={togglePlay}
          onDoubleClick={toggleFullscreen}
        />

        {/* Connecting overlay */}
        {status === 'connecting' && !hasVideo && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0a0a0a] gap-5">
            <div className="relative w-14 h-14">
              <div className="absolute inset-0 border-2 border-white/8 rounded-full" />
              <div className="absolute inset-0 border-2 border-t-red-600 rounded-full spin" />
            </div>
            <div className="text-center px-6">
              <p className="text-white/60 text-sm font-semibold">Connecting to stream&hellip;</p>
              <p className="text-white/25 text-xs mt-1.5 font-mono">{streamId}</p>
              {connectionAttempts > 1 && (
                <p className="text-white/35 text-xs mt-3 max-w-xs leading-relaxed">
                  Waiting for broadcaster to go live. This page will connect automatically.
                </p>
              )}
              {connectionAttempts > 4 && (
                <button
                  onClick={connectToBroadcaster}
                  className="mt-4 px-5 py-2 bg-white/8 hover:bg-white/15 border border-white/12 rounded-lg text-sm text-white/60 transition-colors"
                >
                  Retry connection
                </button>
              )}
            </div>
          </div>
        )}

        {/* Buffering spinner */}
        {isBuffering && hasVideo && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 border-2 border-white/10 rounded-full" />
              <div className="absolute inset-0 border-2 border-t-white rounded-full spin" />
            </div>
          </div>
        )}

        {/* Click to play if autoplay blocked */}
        {hasVideo && !playing && !isBuffering && (
          <div
            className="absolute inset-0 flex items-center justify-center cursor-pointer"
            onClick={togglePlay}
          >
            <div className="w-20 h-20 bg-black/60 backdrop-blur rounded-full flex items-center justify-center border border-white/20 hover:bg-black/80 transition-colors">
              <svg className="w-9 h-9 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}

        {/* Controls */}
        <div className={`absolute inset-0 flex flex-col justify-between transition-opacity duration-200 ${showControls || !playing ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          {/* Top bar */}
          <div className="bg-gradient-to-b from-black/75 to-transparent px-4 pt-3 pb-10">
            <div className="flex items-center gap-3">
              <button onClick={() => (window.location.hash = '#/')} className="text-white/60 hover:text-white transition-colors p-1">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
              </button>
              {streamTitle && <h1 className="text-white font-bold text-sm truncate flex-1">{streamTitle}</h1>}
              {status === 'live' && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-red-600 rounded-md flex-shrink-0">
                  <span className="w-1.5 h-1.5 bg-white rounded-full live-dot" />
                  <span className="text-white text-xs font-black">LIVE</span>
                </div>
              )}
            </div>
          </div>

          {/* Bottom controls */}
          <div className="bg-gradient-to-t from-black/90 via-black/40 to-transparent px-3 pb-3 pt-10">
            {/* Progress bar */}
            <div className="seek-container relative mb-2.5 group">
              <div className="relative h-1 group-hover:h-1.5 transition-all bg-white/20 rounded-full overflow-hidden">
                <div className="absolute h-full bg-white/30 rounded-full" style={{ width: `${bufferedPct}%` }} />
                <div className="absolute h-full bg-red-600 rounded-full" style={{ width: isLiveStream ? '100%' : `${seekPct}%` }} />
              </div>
              {!isLiveStream && duration > 0 && (
                <input type="range" min={0} max={duration} step={0.5} value={currentTime} onChange={seek}
                  className="seek-bar absolute inset-0 w-full h-4 -top-1.5" />
              )}
            </div>

            {/* Buttons */}
            <div className="flex items-center gap-0.5">
              {/* Play/Pause */}
              <button onClick={togglePlay} className="text-white hover:text-white/80 p-2 rounded-lg hover:bg-white/10 transition-colors">
                {playing
                  ? <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                  : <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>}
              </button>

              {/* Volume */}
              <div className="relative flex items-center" onMouseEnter={() => setShowVolume(true)} onMouseLeave={() => setShowVolume(false)}>
                <button onClick={toggleMute} className="text-white hover:text-white/80 p-2 rounded-lg hover:bg-white/10 transition-colors">
                  {muted || volume === 0
                    ? <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 19.73L19 21 20.27 19.73 5.54 5 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                    : volume < 0.5
                    ? <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>
                    : <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>}
                </button>
                {showVolume && (
                  <div className="flex items-center gap-1 w-24">
                    <div className="relative w-full h-1 bg-white/30 rounded-full">
                      <div className="absolute h-full bg-white rounded-full" style={{ width: `${volPct}%` }} />
                    </div>
                    <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume} onChange={e => changeVolume(parseFloat(e.target.value))}
                      className="vol-bar absolute w-24 h-5 opacity-0 cursor-pointer" style={{ left: 40 }} />
                  </div>
                )}
              </div>

              {/* Time */}
              <div className="text-xs tabular-nums ml-1 select-none">
                {isLiveStream
                  ? <span className="text-red-500 font-black">● LIVE</span>
                  : <span className="text-white/60">{fmt(currentTime)} / {fmt(duration)}</span>}
              </div>

              <div className="flex-1" />

              {/* Settings (file only) */}
              {!isLiveStream && (
                <div className="relative">
                  <button onClick={() => { setShowSettings(!showSettings); setShowVolume(false); }} className="text-white/60 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors">
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
                  </button>
                  {showSettings && (
                    <div className="absolute bottom-full right-0 mb-2 bg-[#1a1a1a] border border-white/10 rounded-xl p-2 w-36 shadow-2xl">
                      <div className="text-white/40 text-xs font-bold px-2 py-1 mb-1">Speed</div>
                      {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(rate => (
                        <button key={rate} onClick={() => changePlaybackRate(rate)}
                          className={`w-full text-left px-2 py-1.5 rounded-lg text-sm transition-colors ${playbackRate === rate ? 'bg-red-600 text-white' : 'text-white/60 hover:bg-white/10'}`}>
                          {rate === 1 ? 'Normal' : `${rate}×`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* PiP */}
              {typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && (
                <button onClick={togglePip} className={`p-2 rounded-lg hover:bg-white/10 transition-colors ${pip ? 'text-red-500' : 'text-white/60 hover:text-white'}`}>
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z"/></svg>
                </button>
              )}

              {/* Fullscreen */}
              <button onClick={toggleFullscreen} className="text-white/60 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors">
                {fullscreen
                  ? <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25"/></svg>
                  : <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Below-player info */}
      {!fullscreen && (
        <div className="max-w-5xl w-full mx-auto px-4 py-5 space-y-4">
          <div>
            <h1 className="text-white text-xl font-black leading-tight">
              {streamTitle || (status === 'connecting' ? 'Connecting...' : 'Live Stream')}
            </h1>
            <div className="flex items-center gap-3 mt-2">
              {status === 'live' && (
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 bg-red-600 rounded-full live-dot" />
                    <span className="text-red-500 text-sm font-bold">{isLiveStream ? 'LIVE NOW' : 'STREAMING FILE'}</span>
                  </div>
                  <span className="text-gray-700 text-xs">|</span>
                  <span className="text-gray-600 text-sm">WebRTC P2P via PeerJS</span>
                </>
              )}
              {status === 'connecting' && <span className="text-gray-600 text-sm">Waiting for broadcaster to go live…</span>}
            </div>
          </div>

          <div className="flex items-center gap-3 py-3.5 border-t border-white/6">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-red-600 to-red-900 flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-white text-sm font-bold">StreamStudio</div>
              <div className="text-gray-600 text-xs">End-to-end encrypted · No server · Cross-device</div>
            </div>
            <div className="px-3 py-1.5 bg-white/4 border border-white/8 rounded-full text-xs text-gray-600 font-mono hidden sm:block">
              {streamId.slice(0,16)}&hellip;
            </div>
          </div>

          {status === 'connecting' && connectionAttempts > 2 && (
            <div className="bg-blue-900/15 border border-blue-500/20 rounded-xl p-4">
              <p className="text-blue-400 text-sm font-semibold mb-1">📡 Waiting for broadcaster</p>
              <p className="text-blue-300/50 text-xs leading-relaxed">
                This page connects automatically when the broadcaster goes live. Keep it open — no need to refresh.
                The broadcaster needs to start streaming from the <strong className="text-blue-300/70">Broadcast Studio</strong> with this same stream URL.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ViewerPage;