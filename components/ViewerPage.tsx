import React, { useEffect, useState, useRef, useCallback } from 'react';

declare const Peer: any;

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

// DVR buffer: how many seconds of live stream to keep in memory
const DVR_BUFFER_SECONDS = 120;

const ViewerPage: React.FC<ViewerPageProps> = ({ streamId }) => {
  const [status, setStatus] = useState<'connecting' | 'live' | 'ended'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [connectionAttempts, setConnectionAttempts] = useState(0);

  // Player state
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showVolume, setShowVolume] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [hasVideo, setHasVideo] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [resolution, setResolution] = useState('');

  // DVR / progress state
  const [dvrPosition, setDvrPosition] = useState(0);      // seconds from start of buffer
  const [dvrTotal, setDvrTotal] = useState(0);             // total buffered seconds
  const [isAtLiveEdge, setIsAtLiveEdge] = useState(true);
  const [isSeeking, setIsSeeking] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<any>(null);
  const callRef = useRef<any>(null);
  const controlsTimer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const isConnectingRef = useRef(false);
  const mountedRef = useRef(true);

  // DVR: MediaRecorder + recorded blobs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const dvrChunksRef = useRef<{ blob: Blob; time: number }[]>([]);
  const dvrStartTimeRef = useRef<number>(0);
  const dvrObjectUrlRef = useRef<string | null>(null);
  const liveStreamRef = useRef<MediaStream | null>(null);
  const isPlayingDvrRef = useRef(false);

  const adminPeerId = `${PEER_PREFIX}${streamId}`;

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
  };

  // ─── DVR Recording ───────────────────────────────────────────────────────────

  const startDvrRecording = useCallback((stream: MediaStream) => {
    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop(); } catch {}
    }
    dvrChunksRef.current = [];
    dvrStartTimeRef.current = Date.now();

    // Pick a supported mime type
    const mimeTypes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const mimeType = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || '';

    try {
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          dvrChunksRef.current.push({ blob: e.data, time: Date.now() });

          // Trim old chunks beyond DVR_BUFFER_SECONDS
          const cutoff = Date.now() - DVR_BUFFER_SECONDS * 1000;
          dvrChunksRef.current = dvrChunksRef.current.filter(c => c.time >= cutoff);

          // Update total DVR duration
          const total = (Date.now() - dvrStartTimeRef.current) / 1000;
          setDvrTotal(Math.min(total, DVR_BUFFER_SECONDS));
        }
      };

      recorder.start(500); // collect chunk every 500ms
    } catch (err) {
      console.warn('[DVR] MediaRecorder failed:', err);
    }
  }, []);

  // Build a seekable blob URL from DVR chunks
  const buildDvrBlob = useCallback((): string | null => {
    const chunks = dvrChunksRef.current;
    if (!chunks.length) return null;

    if (dvrObjectUrlRef.current) {
      URL.revokeObjectURL(dvrObjectUrlRef.current);
    }
    const mimeType = chunks[0].blob.type || 'video/webm';
    const combined = new Blob(chunks.map(c => c.blob), { type: mimeType });
    const url = URL.createObjectURL(combined);
    dvrObjectUrlRef.current = url;
    return url;
  }, []);

  // Switch to DVR playback at a given position (seconds from start of buffer)
  const seekToDvr = useCallback((positionSeconds: number) => {
    const video = videoRef.current;
    if (!video) return;

    isPlayingDvrRef.current = true;
    setIsAtLiveEdge(false);

    const url = buildDvrBlob();
    if (!url) return;

    const prevVolume = video.volume;
    const prevMuted = video.muted;

    video.pause();
    video.srcObject = null;
    video.src = url;
    video.volume = prevVolume;
    video.muted = prevMuted;

    video.onloadedmetadata = () => {
      const dur = video.duration;
      if (isFinite(dur) && dur > 0) {
        // Map positionSeconds into the blob's timeline
        const target = Math.min(positionSeconds, dur - 0.5);
        video.currentTime = Math.max(0, target);
      }
      video.play().catch(() => {});
    };
  }, [buildDvrBlob]);

  // Return to live edge
  const goToLive = useCallback(() => {
    const video = videoRef.current;
    if (!video || !liveStreamRef.current) return;

    isPlayingDvrRef.current = false;
    setIsAtLiveEdge(true);

    if (dvrObjectUrlRef.current) {
      URL.revokeObjectURL(dvrObjectUrlRef.current);
      dvrObjectUrlRef.current = null;
    }

    const prevVolume = video.volume;
    const prevMuted = video.muted;

    video.pause();
    video.src = '';
    video.removeAttribute('src');
    video.srcObject = liveStreamRef.current;
    video.volume = prevVolume;
    video.muted = prevMuted;
    video.play().catch(() => {});
  }, []);

  // ─── Safe Play ────────────────────────────────────────────────────────────────

  const safePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return false;
    try {
      if (video.paused) {
        await video.play();
        setPlaying(true);
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  const togglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      await safePlay();
    } else {
      video.pause();
      setPlaying(false);
    }
  }, [safePlay]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
    if (!video.muted && video.volume === 0) {
      video.volume = 0.5;
      setVolume(0.5);
    }
  }, []);

  const changeVolume = useCallback((val: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = val;
    video.muted = val === 0;
    setVolume(val);
    setMuted(val === 0);
  }, []);

  const changePlaybackRate = useCallback((rate: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    setPlaybackRate(rate);
    setShowSettings(false);
  }, []);

  // Progress bar seek (maps 0–100 → position in DVR buffer)
  const handleSeek = useCallback((val: number) => {
    const posSeconds = (val / 100) * dvrTotal;
    seekToDvr(posSeconds);
  }, [dvrTotal, seekToDvr]);

  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {}
  }, []);

  const resetControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = window.setTimeout(() => {
      setShowControls(false);
      setShowVolume(false);
      setShowSettings(false);
    }, 3000);
  }, []);

  // ─── Peer / Connection ────────────────────────────────────────────────────────

  const destroyPeer = useCallback(() => {
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop(); } catch {}
      mediaRecorderRef.current = null;
    }
    if (callRef.current) { try { callRef.current.close(); } catch {}; callRef.current = null; }
    if (peerRef.current) { try { peerRef.current.destroy(); } catch {}; peerRef.current = null; }
    isConnectingRef.current = false;
  }, []);

  const connectToBroadcaster = useCallback(() => {
    if (!mountedRef.current || isConnectingRef.current) return;
    isConnectingRef.current = true;
    destroyPeer();

    const viewerId = `v-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;

    try {
      const peer = new Peer(viewerId, { config: { iceServers: ICE_SERVERS } });
      peerRef.current = peer;

      peer.on('open', () => {
        if (!mountedRef.current) return;
        isConnectingRef.current = false;

        // Dummy stream just to initiate the call
        const canvas = document.createElement('canvas');
        canvas.width = 2; canvas.height = 2;
        const dummyStream = canvas.captureStream(1);

        const call = peer.call(adminPeerId, dummyStream);
        callRef.current = call;

        call.on('stream', (remoteStream: MediaStream) => {
          if (!mountedRef.current) return;
          console.log('[Viewer] Got stream, tracks:', remoteStream.getTracks().map(t => `${t.kind}:${t.enabled}`));

          liveStreamRef.current = remoteStream;
          const video = videoRef.current;
          if (!video) return;

          // Assign live stream
          video.srcObject = remoteStream;
          // DO NOT mute — viewer must hear audio
          video.muted = false;
          video.volume = volume;

          setHasVideo(true);
          setStatus('live');
          setIsBuffering(false);
          isPlayingDvrRef.current = false;
          setIsAtLiveEdge(true);

          // Attempt autoplay; if blocked, user taps play
          video.play().catch(() => {
            setPlaying(false);
          });

          // Update resolution info
          const videoTrack = remoteStream.getVideoTracks()[0];
          if (videoTrack) {
            const settings = videoTrack.getSettings();
            if (settings.width && settings.height) {
              setResolution(`${settings.width}×${settings.height}`);
            }
          }

          // Start DVR recording
          startDvrRecording(remoteStream);
        });

        call.on('close', () => {
          if (!mountedRef.current) return;
          setStatus('ended');
          setErrorMsg('The broadcast has ended');
          if (videoRef.current) videoRef.current.srcObject = null;
        });

        call.on('error', () => {
          setConnectionAttempts(prev => prev + 1);
        });
      });

      peer.on('error', (err: any) => {
        if (!mountedRef.current) return;
        isConnectingRef.current = false;
        if (err.type === 'peer-unavailable') {
          setConnectionAttempts(prev => prev + 1);
          retryTimer.current = window.setTimeout(() => {
            if (mountedRef.current) connectToBroadcaster();
          }, 3000);
        } else if (['unavailable-id', 'network', 'server-error'].includes(err.type)) {
          retryTimer.current = window.setTimeout(() => {
            if (mountedRef.current) connectToBroadcaster();
          }, 2000);
        }
      });

      peer.on('disconnected', () => {
        if (!mountedRef.current) return;
        retryTimer.current = window.setTimeout(() => {
          if (mountedRef.current) connectToBroadcaster();
        }, 3000);
      });
    } catch {
      isConnectingRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminPeerId, destroyPeer, startDvrRecording]);

  // ─── Effects ──────────────────────────────────────────────────────────────────

  // Init connection
  useEffect(() => {
    mountedRef.current = true;
    connectToBroadcaster();
    resetControls();

    const onFSChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFSChange);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('fullscreenchange', onFSChange);
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
      if (dvrObjectUrlRef.current) URL.revokeObjectURL(dvrObjectUrlRef.current);
      destroyPeer();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Video event listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => setIsBuffering(false);
    const onVolumeChange = () => {
      setMuted(video.muted);
      setVolume(video.volume);
    };
    const onTimeUpdate = () => {
      if (!isPlayingDvrRef.current) return;
      // Map current playback time to DVR position
      const dur = video.duration;
      if (isFinite(dur) && dur > 0) {
        const frac = video.currentTime / dur;
        setDvrPosition(frac * dvrTotal);
      }
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('timeupdate', onTimeUpdate);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [dvrTotal]);

  // Tick DVR total & position while live
  useEffect(() => {
    const tick = setInterval(() => {
      if (!isPlayingDvrRef.current && hasVideo) {
        const elapsed = (Date.now() - dvrStartTimeRef.current) / 1000;
        const total = Math.min(elapsed, DVR_BUFFER_SECONDS);
        setDvrTotal(total);
        setDvrPosition(total); // at live edge
      }
    }, 500);
    return () => clearInterval(tick);
  }, [hasVideo]);

  // ─── Rendered ────────────────────────────────────────────────────────────────

  if (status === 'ended') {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-20 h-20 mx-auto bg-white/10 rounded-2xl flex items-center justify-center">
            <svg className="w-10 h-10 text-white/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Stream Ended</h2>
            <p className="text-white/50 mt-2">This broadcast has ended or the link is no longer valid.</p>
          </div>
          <button
            onClick={() => { window.location.hash = '#/'; }}
            className="px-6 py-2 bg-white text-black font-medium rounded-full hover:bg-white/90 transition-colors"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  const volumePercent = (muted ? 0 : volume) * 100;
  // Progress bar: 0–100 representing position within DVR buffer
  const seekPercent = dvrTotal > 0 ? (dvrPosition / dvrTotal) * 100 : 100;

  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Player */}
      <div
        ref={containerRef}
        className={`relative bg-black flex-1 ${fullscreen ? 'fixed inset-0 z-50' : 'w-full'}`}
        style={!fullscreen ? { aspectRatio: '16/9', maxHeight: '100vh' } : {}}
        onMouseMove={resetControls}
        onTouchStart={resetControls}
        onMouseLeave={() => {
          if (controlsTimer.current) clearTimeout(controlsTimer.current);
          controlsTimer.current = window.setTimeout(() => {
            setShowControls(false);
            setShowVolume(false);
            setShowSettings(false);
          }, 1200);
        }}
      >
        {/* ── Video Element ── */}
        <video
          ref={videoRef}
          className="w-full h-full object-contain bg-black"
          playsInline
          autoPlay
          onClick={togglePlay}
          onDoubleClick={toggleFullscreen}
          // No muted attr here — we want audio
        />

        {/* ── Connecting overlay ── */}
        {status === 'connecting' && !hasVideo && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-950">
            <div className="text-center">
              <div className="w-12 h-12 border-2 border-white/20 border-t-white rounded-full spin mx-auto mb-4" />
              <p className="text-white/80 text-sm font-medium">Connecting to stream…</p>
              {connectionAttempts > 0 && (
                <p className="text-white/40 text-xs mt-1">Attempt {connectionAttempts + 1}</p>
              )}
              {connectionAttempts > 3 && (
                <button
                  onClick={connectToBroadcaster}
                  className="mt-4 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-white text-sm transition-colors"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Buffering spinner ── */}
        {isBuffering && hasVideo && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 border-2 border-white/20 border-t-white rounded-full spin" />
          </div>
        )}

        {/* ── Paused play button ── */}
        {hasVideo && !playing && !isBuffering && (
          <div
            className="absolute inset-0 flex items-center justify-center cursor-pointer"
            onClick={togglePlay}
          >
            <div className="w-20 h-20 bg-black/60 rounded-full flex items-center justify-center hover:bg-black/80 transition-colors backdrop-blur-sm">
              <svg className="w-10 h-10 text-white ml-1" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}

        {/* ── Controls overlay ── */}
        <div
          className={`absolute inset-0 flex flex-col justify-between transition-opacity duration-300 ${
            showControls || !playing ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* Top bar */}
          <div className="bg-gradient-to-b from-black/70 to-transparent px-4 pt-3 pb-6">
            <div className="flex items-center gap-2">
              {hasVideo && (
                <span className="flex items-center gap-1.5 px-2 py-1 bg-red-600 rounded text-white text-xs font-bold">
                  <span className="w-1.5 h-1.5 bg-white rounded-full live-dot" />
                  LIVE
                </span>
              )}
              {resolution && (
                <span className="text-white/60 text-xs font-mono">{resolution}</span>
              )}
            </div>
          </div>

          {/* Bottom controls */}
          <div className="bg-gradient-to-t from-black/80 to-transparent px-3 pb-3 pt-8 space-y-1">

            {/* ── Progress / DVR bar ── */}
            <div
              className="group relative flex items-center h-5 cursor-pointer"
              onMouseDown={(e) => {
                if (!hasVideo || dvrTotal < 1) return;
                setIsSeeking(true);
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                handleSeek(pct * 100);
              }}
              onMouseMove={(e) => {
                if (!isSeeking) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                handleSeek(pct * 100);
              }}
              onMouseUp={() => setIsSeeking(false)}
              onMouseLeave={() => setIsSeeking(false)}
              onTouchStart={(e) => {
                if (!hasVideo || dvrTotal < 1) return;
                setIsSeeking(true);
                const rect = e.currentTarget.getBoundingClientRect();
                const touch = e.touches[0];
                const pct = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
                handleSeek(pct * 100);
              }}
              onTouchMove={(e) => {
                if (!isSeeking) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const touch = e.touches[0];
                const pct = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
                handleSeek(pct * 100);
              }}
              onTouchEnd={() => setIsSeeking(false)}
            >
              {/* Track */}
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 group-hover:h-1.5 transition-all rounded-full bg-white/25">
                {/* Buffered */}
                <div className="absolute inset-y-0 left-0 rounded-full bg-white/40" style={{ width: '100%' }} />
                {/* Played */}
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-red-500"
                  style={{ width: `${seekPercent}%` }}
                />
                {/* Thumb */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 transition-opacity -translate-x-1/2"
                  style={{ left: `${seekPercent}%` }}
                />
              </div>
            </div>

            {/* ── Control row ── */}
            <div className="flex items-center gap-1 sm:gap-2">

              {/* Play / Pause */}
              <button
                onClick={togglePlay}
                className="text-white hover:text-white/80 transition-colors p-1 flex-shrink-0"
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? (
                  <svg className="w-7 h-7 sm:w-8 sm:h-8" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg className="w-7 h-7 sm:w-8 sm:h-8" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              {/* Volume */}
              <div
                className="relative flex items-center gap-1"
                onMouseEnter={() => setShowVolume(true)}
                onMouseLeave={() => setShowVolume(false)}
              >
                <button
                  onClick={toggleMute}
                  className="text-white hover:text-white/80 transition-colors p-1 flex-shrink-0"
                  aria-label={muted ? 'Unmute' : 'Mute'}
                >
                  {muted || volume === 0 ? (
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 19.73L19 21 20.27 19.73 5.54 5 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                    </svg>
                  ) : volume < 0.5 ? (
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                    </svg>
                  )}
                </button>
                {/* Volume slider — show on hover (desktop) or always on mobile */}
                <div className={`items-center w-16 sm:w-20 ${showVolume ? 'flex' : 'hidden sm:hidden'}`}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.02}
                    value={muted ? 0 : volume}
                    onChange={e => changeVolume(parseFloat(e.target.value))}
                    className="volume-slider w-full"
                    style={{
                      background: `linear-gradient(to right, white ${volumePercent}%, rgba(255,255,255,0.3) ${volumePercent}%)`
                    }}
                  />
                </div>
              </div>

              {/* Time */}
              <div className="text-white/80 text-xs font-mono ml-1 flex-shrink-0 hidden sm:block">
                {isAtLiveEdge ? (
                  <span className="text-white font-semibold">LIVE</span>
                ) : (
                  <span>-{formatTime(dvrTotal - dvrPosition)}</span>
                )}
              </div>

              <div className="flex-1" />

              {/* Go to Live button (only when seeking back) */}
              {!isAtLiveEdge && (
                <button
                  onClick={goToLive}
                  className="flex items-center gap-1 px-2 py-1 bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded transition-colors flex-shrink-0"
                >
                  <span className="w-1.5 h-1.5 bg-white rounded-full live-dot flex-shrink-0" />
                  LIVE
                </button>
              )}

              {/* Settings */}
              <div className="relative flex-shrink-0">
                <button
                  onClick={() => { setShowSettings(s => !s); setShowVolume(false); }}
                  className="text-white/70 hover:text-white transition-colors p-1"
                  aria-label="Settings"
                >
                  <svg className="w-5 h-5 sm:w-6 sm:h-6" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                  </svg>
                </button>

                {showSettings && (
                  <div className="absolute bottom-full right-0 mb-2 w-44 bg-gray-900/95 backdrop-blur-sm rounded-xl shadow-2xl border border-white/10 py-2 text-sm">
                    {/* Quality */}
                    <div className="px-3 py-1.5 text-xs font-semibold text-white/40 uppercase tracking-wider">Quality</div>
                    <div className="px-3 py-1.5 flex items-center justify-between">
                      <span className="text-white/70">Resolution</span>
                      <span className="text-white font-mono text-xs">{resolution || 'Auto'}</span>
                    </div>
                    <div className="h-px bg-white/10 my-1.5 mx-3" />
                    {/* Playback speed */}
                    <div className="px-3 py-1.5 text-xs font-semibold text-white/40 uppercase tracking-wider">Speed</div>
                    {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                      <button
                        key={rate}
                        onClick={() => changePlaybackRate(rate)}
                        className={`w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-white/10 transition-colors ${
                          playbackRate === rate ? 'text-red-400 font-semibold' : 'text-white/80'
                        }`}
                      >
                        <span>{rate === 1 ? 'Normal' : `${rate}×`}</span>
                        {playbackRate === rate && (
                          <svg className="w-3 h-3 text-red-400" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                          </svg>
                        )}
                      </button>
                    ))}
                    {/* DVR info */}
                    {dvrTotal > 0 && (
                      <>
                        <div className="h-px bg-white/10 my-1.5 mx-3" />
                        <div className="px-3 py-1.5 text-xs font-semibold text-white/40 uppercase tracking-wider">DVR Buffer</div>
                        <div className="px-3 py-1.5 text-white/60 text-xs">
                          {formatTime(dvrTotal)} available
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className="text-white/70 hover:text-white transition-colors p-1 flex-shrink-0"
                aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              >
                {fullscreen ? (
                  <svg className="w-5 h-5 sm:w-6 sm:h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M15 9h4.5M15 9V4.5M15 9l5.25-5.25M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 sm:w-6 sm:h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile volume tap zone (unmute hint) */}
        {hasVideo && muted && (
          <div
            className="absolute top-14 right-3 flex items-center gap-2 px-3 py-1.5 bg-black/70 backdrop-blur-sm rounded-full cursor-pointer sm:hidden"
            onClick={toggleMute}
          >
            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 19.73L19 21 20.27 19.73 5.54 5 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
            </svg>
            <span className="text-white text-xs font-medium">Tap to unmute</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default ViewerPage;
