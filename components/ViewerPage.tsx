// ViewerPage.tsx (updated with resolution switching)
import React, { useEffect, useState, useRef, useMemo } from 'react';
import { StreamMode, Resolution } from '../types';

interface ViewerPageProps {
  streamId: string;
}

const fmt = (s: number) =>
  isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';

const HEARTBEAT_INTERVAL = 5000;

// Available resolutions for viewers
const VIEWER_RESOLUTIONS: Resolution[] = [
  { width: 640, height: 480, label: '480p (SD)' },
  { width: 854, height: 480, label: '480p (16:9)' },
  { width: 960, height: 540, label: '540p' },
  { width: 1280, height: 720, label: '720p (HD)' },
  { width: 1920, height: 1080, label: '1080p (Full HD)' },
];

const ViewerPage: React.FC<ViewerPageProps> = ({ streamId }) => {
  const [streamInfo, setStreamInfo] = useState<{ title: string; mode: StreamMode } | null>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'ended'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');

  // Player state
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showVolume, setShowVolume] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [pip, setPip] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectedResolution, setSelectedResolution] = useState<Resolution>(VIEWER_RESOLUTIONS[3]); // 720p default
  const [availableResolutions, setAvailableResolutions] = useState<Resolution[]>(VIEWER_RESOLUTIONS);
  const [showResolutions, setShowResolutions] = useState(false);
  const [stats, setStats] = useState<{ bitrate: number; fps: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const playPromiseRef = useRef<Promise<void> | null>(null);
  const controlsTimer = useRef<number | null>(null);
  const streamInfoRef = useRef<typeof streamInfo>(null);
  const heartbeatTimer = useRef<number | null>(null);
  const statsTimer = useRef<number | null>(null);

  const viewerId = useMemo(
    () => `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
    []
  );

  // ── Safe play ─────────────────────────────────────────────────────────────
  const safePlay = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (playPromiseRef.current) await playPromiseRef.current.catch(() => {});
      playPromiseRef.current = v.play();
      await playPromiseRef.current;
      setPlaying(true);
    } catch (e: any) {
      if (e.name !== 'AbortError') console.warn(e);
    } finally {
      playPromiseRef.current = null;
    }
  };

  // ── Controls auto-hide ───────────────────────────────────────────────────
  const resetControls = () => {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = window.setTimeout(() => {
      setShowControls(false);
      setShowVolume(false);
      setShowSettings(false);
      setShowResolutions(false);
    }, 3500);
  };

  // ── Get stream statistics ────────────────────────────────────────────────
  const updateStats = () => {
    if (!pcRef.current || !videoRef.current) return;
    
    const videoTrack = videoRef.current.srcObject instanceof MediaStream
      ? videoRef.current.srcObject.getVideoTracks()[0]
      : null;
    
    if (videoTrack && 'getStats' in pcRef.current) {
      // @ts-ignore - getStats is available but types are complex
      pcRef.current.getStats(null).then((reports: any) => {
        let bitrate = 0;
        let fps = 0;
        
        reports.forEach((report: any) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            bitrate = Math.round(report.bitrateMean || 0);
            fps = Math.round(report.framesPerSecond || 0);
          }
        });
        
        setStats({ bitrate, fps });
      }).catch(() => {});
    }
  };

  // ── Main effect ───────────────────────────────────────────────────────────
  useEffect(() => {
    const bc = new BroadcastChannel('secure_stream_channel');
    bcRef.current = bc;

    // ── WebRTC offer handler ──────────────────────────────────────────────
    const handleOffer = async (
      offer: RTCSessionDescriptionInit,
      offerStreamId: string,
      title: string,
      mode: StreamMode,
      streamResolution?: Resolution
    ) => {
      if (offerStreamId !== streamId) return;
      pcRef.current?.close();

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      pcRef.current = pc;

      pc.onicecandidate = e => {
        if (e.candidate)
          bc.postMessage({ type: 'SIGNAL_ICE', payload: { viewerId, candidate: e.candidate.toJSON() } });
      };

      pc.ontrack = async event => {
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = event.streams[0];
        setStatus('live');
        await safePlay();
        
        // Start stats collection
        if (statsTimer.current) clearInterval(statsTimer.current);
        statsTimer.current = window.setInterval(updateStats, 2000);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setStatus('live');
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setStatus('connecting');
          bc.postMessage({ type: 'VIEWER_JOIN', payload: { streamId, viewerId } });
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(offer)).catch(console.error);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      bc.postMessage({ type: 'SIGNAL_ANSWER', payload: { viewerId, answer } });

      const info = { title, mode };
      streamInfoRef.current = info;
      setStreamInfo(info);
      
      // Update available resolutions if provided
      if (streamResolution) {
        setAvailableResolutions(prev => {
          const exists = prev.some(r => r.width === streamResolution.width);
          if (!exists) {
            return [...prev, streamResolution];
          }
          return prev;
        });
      }
    };

    // ── Message handler ───────────────────────────────────────────────────
    bc.onmessage = async (event) => {
      const { type, payload } = event.data;
      if (payload?.viewerId && payload.viewerId !== viewerId && type !== 'STOP_STREAM') return;

      switch (type) {
        case 'STREAM_UPDATE':
          if (payload.streamId === streamId) {
            const info = { title: payload.title, mode: payload.mode };
            streamInfoRef.current = info;
            setStreamInfo(info);
            setStatus('live');
            
            if (payload.resolution) {
              setAvailableResolutions(prev => {
                const exists = prev.some(r => r.width === payload.resolution.width);
                if (!exists) {
                  return [...prev, payload.resolution];
                }
                return prev;
              });
            }
          }
          break;
        case 'SIGNAL_OFFER':
          await handleOffer(payload.offer, payload.streamId, payload.title, payload.mode, payload.resolution);
          break;
        case 'SIGNAL_ICE_ADMIN':
          if (pcRef.current && payload.candidate)
            await pcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
          break;
        case 'STOP_STREAM':
          streamInfoRef.current = null;
          setStreamInfo(null);
          setStatus('ended');
          setErrorMsg('The broadcast has ended.');
          pcRef.current?.close();
          if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
          if (statsTimer.current) clearInterval(statsTimer.current);
          break;
      }
    };

    // ── Announce presence & retry until admin responds ────────────────────
    const announce = () => bc.postMessage({ type: 'VIEWER_JOIN', payload: { streamId, viewerId } });
    announce();
    const joinInterval = setInterval(() => {
      if (!streamInfoRef.current) announce();
      else clearInterval(joinInterval);
    }, 2000);

    // ── Heartbeat ──────────────────────────────────────────────────────────
    heartbeatTimer.current = window.setInterval(() => {
      bc.postMessage({ type: 'VIEWER_HEARTBEAT', payload: { streamId, viewerId } });
    }, HEARTBEAT_INTERVAL);

    // ── Reliable leave on tab/window close ────────────────────────────────
    const sendLeave = () => {
      bc.postMessage({ type: 'VIEWER_LEAVE', payload: { streamId, viewerId } });
    };
    window.addEventListener('beforeunload', sendLeave);
    window.addEventListener('pagehide', sendLeave);

    // Controls
    document.addEventListener('mousemove', resetControls);
    document.addEventListener('touchstart', resetControls);
    document.addEventListener('fullscreenchange', () => setFullscreen(!!document.fullscreenElement));
    resetControls();

    return () => {
      clearInterval(joinInterval);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      if (statsTimer.current) clearInterval(statsTimer.current);

      sendLeave();
      bc.close();
      pcRef.current?.close();

      window.removeEventListener('beforeunload', sendLeave);
      window.removeEventListener('pagehide', sendLeave);
      document.removeEventListener('mousemove', resetControls);
      document.removeEventListener('touchstart', resetControls);
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
    };
  }, [streamId, viewerId]);

  // ── Video event bindings ──────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onDur = () => setDuration(v.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onDur);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onDur);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
    };
  }, []);

  // ── Player controls ───────────────────────────────────────────────────────
  const togglePlay = async () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) await safePlay();
    else {
      v.pause();
      setPlaying(false);
    }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const changeVolume = (val: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = val;
    v.muted = val === 0;
    setVolume(val);
    setMuted(val === 0);
  };

  const changePlaybackRate = (rate: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = rate;
    setPlaybackRate(rate);
    setShowSettings(false);
  };

  const changeResolution = (resolution: Resolution) => {
    setSelectedResolution(resolution);
    setShowResolutions(false);
    
    // Request stream with new resolution
    if (pcRef.current && streamId) {
      // Re-negotiate WebRTC with new resolution
      bcRef.current?.postMessage({
        type: 'VIEWER_JOIN',
        payload: { streamId, viewerId, resolution }
      });
    }
  };

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    v.currentTime = parseFloat(e.target.value);
  };

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) await containerRef.current.requestFullscreen().catch(() => {});
    else await document.exitFullscreen().catch(() => {});
  };

  const togglePip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setPip(false);
      } else {
        await v.requestPictureInPicture();
        setPip(true);
      }
    } catch { /* unsupported */ }
  };

  const isLiveOnly = !duration || !isFinite(duration);
  const volPct = (muted ? 0 : volume) * 100;
  const seekPct = duration ? (currentTime / duration) * 100 : 0;

  // ── Ended screen ──
  if (status === 'ended') {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto">
            <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-gray-900">Stream Ended</h2>
          <p className="text-gray-400 text-sm">{errorMsg}</p>
        </div>
      </div>
    );
  }

  // ── Main viewer ───────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* ── Title bar (hidden in fullscreen) ── */}
      {!fullscreen && (
        <div className="bg-white border-b border-gray-100 px-4 sm:px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => (window.location.hash = '#/')}
            className="text-gray-400 hover:text-gray-900 transition-colors flex-shrink-0"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold text-gray-900 truncate">
              {streamInfo?.title || 'Connecting…'}
            </h1>
            <div className="flex items-center gap-2 mt-0.5">
              {status === 'live' ? (
                <>
                  <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                  <span className="text-xs font-semibold text-red-500">Live</span>
                </>
              ) : (
                <span className="text-xs text-gray-400">Connecting…</span>
              )}
              {stats && stats.bitrate > 0 && (
                <span className="text-xs text-gray-400 ml-2">
                  {Math.round(stats.bitrate / 1000)} kbps · {stats.fps} fps
                </span>
              )}
            </div>
          </div>

          <span className="text-xs text-gray-300 font-mono flex-shrink-0 hidden sm:inline">🔒 Secured</span>
        </div>
      )}

      {/* ── Video player ── */}
      <div className="flex-1 flex flex-col bg-black">
        <div
          ref={containerRef}
          className="relative w-full flex-1"
          style={{ minHeight: 0 }}
          onMouseMove={resetControls}
          onMouseLeave={() => {
            if (controlsTimer.current) clearTimeout(controlsTimer.current);
            controlsTimer.current = window.setTimeout(() => setShowControls(false), 800);
          }}
          onClick={togglePlay}
        >
          {/* Video element */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="w-full h-full object-contain bg-black"
            style={{ display: 'block', minHeight: '100%' }}
            onContextMenu={e => e.preventDefault()}
          />

          {/* Connecting spinner */}
          {status === 'connecting' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black p-4">
              <div className="relative w-12 h-12">
                <div className="absolute inset-0 border-2 border-white/10 rounded-full" />
                <div className="absolute inset-0 border-2 border-t-white rounded-full animate-spin" />
              </div>
              <div className="text-center space-y-1">
                <p className="text-white/50 text-sm font-medium">Connecting to stream…</p>
                <p className="text-white/20 text-xs font-mono break-all">{streamId}</p>
              </div>
            </div>
          )}

          {/* ── Controls overlay ── */}
          <div
            className={`absolute inset-0 flex flex-col justify-between transition-opacity duration-300 pointer-events-none ${
              showControls || !playing ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {/* Top gradient + title */}
            <div className="bg-gradient-to-b from-black/70 to-transparent pt-5 pb-10 px-4 sm:px-5 pointer-events-auto">
              {(fullscreen || status === 'live') && streamInfo?.title && (
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-white font-bold text-base sm:text-lg drop-shadow leading-tight truncate">
                      {streamInfo.title}
                    </p>
                    {status === 'live' && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                        <span className="text-red-400 text-xs font-bold uppercase tracking-wide">Live</span>
                      </div>
                    )}
                  </div>
                  {fullscreen && (
                    <button
                      onClick={e => { e.stopPropagation(); window.location.hash = '#/'; }}
                      className="text-white/50 hover:text-white transition-colors flex-shrink-0"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Bottom controls */}
            <div
              className="bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 sm:px-5 pb-3 sm:pb-4 pt-12 pointer-events-auto"
              onClick={e => e.stopPropagation()}
            >
              {/* Seek bar (file upload only) */}
              {!isLiveOnly && (
                <div className="mb-3 flex items-center gap-2 sm:gap-3">
                  <span className="text-white/50 text-xs font-mono tabular-nums w-10 text-right">
                    {fmt(currentTime)}
                  </span>
                  <div className="flex-1 relative group">
                    <input
                      type="range"
                      min={0}
                      max={duration || 100}
                      step={0.1}
                      value={currentTime}
                      onChange={seek}
                      className="w-full h-1 rounded-full appearance-none cursor-pointer bg-white/20
                        [&::-webkit-slider-thumb]:appearance-none
                        [&::-webkit-slider-thumb]:w-3
                        [&::-webkit-slider-thumb]:h-3
                        [&::-webkit-slider-thumb]:rounded-full
                        [&::-webkit-slider-thumb]:bg-white
                        [&::-webkit-slider-thumb]:opacity-0
                        group-hover:[&::-webkit-slider-thumb]:opacity-100"
                      style={{ background: `linear-gradient(to right,white ${seekPct}%,rgba(255,255,255,0.2) ${seekPct}%)` }}
                    />
                  </div>
                  <span className="text-white/50 text-xs font-mono tabular-nums w-10">
                    {fmt(duration)}
                  </span>
                </div>
              )}

              {/* Live progress bar */}
              {isLiveOnly && status === 'live' && (
                <div className="mb-3 flex items-center gap-3">
                  <div className="flex-1 h-0.5 bg-white/20 rounded-full overflow-hidden">
                    <div className="h-full bg-red-500 w-full" />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                    <span className="text-red-400 text-xs font-bold uppercase tracking-wide">Live</span>
                  </div>
                </div>
              )}

              {/* Button row */}
              <div className="flex items-center gap-1 sm:gap-2 flex-wrap">
                {/* Play / Pause */}
                <button
                  onClick={togglePlay}
                  className="p-2 sm:p-2.5 text-white hover:text-white/70 transition-colors rounded-lg hover:bg-white/10"
                >
                  {playing ? (
                    <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>

                {/* Volume */}
                <div
                  className="relative flex items-center"
                  onMouseEnter={() => setShowVolume(true)}
                  onMouseLeave={() => setShowVolume(false)}
                >
                  <button
                    onClick={toggleMute}
                    className="p-2 sm:p-2.5 text-white hover:text-white/70 transition-colors rounded-lg hover:bg-white/10"
                  >
                    {muted || volume === 0 ? (
                      <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 19.73L19 21 20.27 19.73 5.54 5 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                      </svg>
                    ) : volume < 0.5 ? (
                      <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                      </svg>
                    )}
                  </button>

                  {/* Volume slider popup */}
                  {showVolume && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-gray-900/95 backdrop-blur rounded-2xl px-3 py-3 flex flex-col items-center gap-2 z-10 shadow-xl">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.02}
                        value={muted ? 0 : volume}
                        onChange={e => changeVolume(parseFloat(e.target.value))}
                        className="h-20 sm:h-24 w-1.5 rounded-full appearance-none cursor-pointer"
                        style={{
                          writingMode: 'vertical-lr',
                          direction: 'rtl',
                          background: `linear-gradient(to top, white ${volPct}%, rgba(255,255,255,0.2) ${volPct}%)`,
                        } as React.CSSProperties}
                      />
                      <span className="text-white/50 text-xs tabular-nums">{Math.round(volPct)}%</span>
                    </div>
                  )}
                </div>

                {/* Resolution selector */}
                <div className="relative">
                  <button
                    onClick={() => setShowResolutions(!showResolutions)}
                    className="p-2 sm:p-2.5 text-white hover:text-white/70 transition-colors rounded-lg hover:bg-white/10 hidden sm:block"
                    title="Quality"
                  >
                    <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm0 16H5V5h14v14zM7 9h10v2H7zm0 4h6v2H7z" />
                    </svg>
                  </button>

                  {showResolutions && (
                    <div className="absolute bottom-full right-0 mb-2 bg-gray-900/95 backdrop-blur-xl rounded-2xl p-3 w-48 shadow-2xl z-10">
                      <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-2 px-2">Quality</p>
                      <div className="space-y-0.5 max-h-48 overflow-y-auto">
                        {availableResolutions.map(res => (
                          <button
                            key={`${res.width}x${res.height}`}
                            onClick={() => changeResolution(res)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                              selectedResolution.width === res.width
                                ? 'bg-white/20 text-white font-semibold'
                                : 'text-white/60 hover:bg-white/10 hover:text-white'
                            }`}
                          >
                            {res.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Spacer */}
                <div className="flex-1" />

                {/* Stats (mobile) */}
                {stats && stats.bitrate > 0 && (
                  <span className="text-white/50 text-xs hidden sm:block">
                    {Math.round(stats.bitrate / 1000)} kbps
                  </span>
                )}

                {/* PiP */}
                {typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && (document as any).pictureInPictureEnabled && (
                  <button
                    onClick={togglePip}
                    className={`p-2 sm:p-2.5 transition-colors rounded-lg hover:bg-white/10 ${pip ? 'text-blue-400' : 'text-white/70 hover:text-white'}`}
                    title="Picture in Picture"
                  >
                    <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z" />
                    </svg>
                  </button>
                )}

                {/* Settings */}
                <div className="relative">
                  <button
                    onClick={() => setShowSettings(s => !s)}
                    className={`p-2 sm:p-2.5 transition-colors rounded-lg hover:bg-white/10 ${showSettings ? 'text-white' : 'text-white/70 hover:text-white'}`}
                    title="Settings"
                  >
                    <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96a7.02 7.02 0 00-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" />
                    </svg>
                  </button>

                  {showSettings && (
                    <div className="absolute bottom-full right-0 mb-2 bg-gray-900/95 backdrop-blur-xl rounded-2xl p-4 w-48 shadow-2xl z-10">
                      <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-2">Speed</p>
                      <div className="space-y-0.5">
                        {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                          <button
                            key={rate}
                            onClick={() => changePlaybackRate(rate)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                              playbackRate === rate
                                ? 'bg-white/20 text-white font-semibold'
                                : 'text-white/60 hover:bg-white/10 hover:text-white'
                            }`}
                          >
                            {rate === 1 ? 'Normal' : `${rate}×`}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Fullscreen */}
                <button
                  onClick={toggleFullscreen}
                  className="p-2 sm:p-2.5 text-white hover:text-white/70 transition-colors rounded-lg hover:bg-white/10"
                  title="Fullscreen"
                >
                  {fullscreen ? (
                    <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9L4 4m0 0v5m0-5h5m6-1h5m0 0v5m0-5l-5 5M9 15l-5 5m0 0h5m-5 0v-5m16 0v5m0 0h-5m5 0l-5-5" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Subtle watermark */}
          <div className="absolute inset-0 pointer-events-none select-none overflow-hidden opacity-[0.03]">
            <div
              className="absolute text-white font-black uppercase whitespace-nowrap"
              style={{ fontSize: 'clamp(2rem, 5vw, 5rem)', top: '20%', left: '5%', transform: 'rotate(-12deg)' }}
            >
              {viewerId.slice(0, 8)}
            </div>
          </div>
        </div>
      </div>

      {/* ── Below-video info bar ── */}
      {!fullscreen && (
        <div className="bg-white border-t border-gray-100 px-4 sm:px-6 py-3 sm:py-4">
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-gray-900 truncate">
                {streamInfo?.title || 'Live Stream'}
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {status === 'connecting'
                  ? 'Waiting for broadcaster…'
                  : status === 'live'
                  ? 'Streaming live now'
                  : 'Stream ended'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {/* Mobile resolution selector */}
              <div className="relative sm:hidden">
                <button
                  onClick={() => setShowResolutions(!showResolutions)}
                  className="text-xs text-gray-400 hover:text-gray-900 transition-colors flex items-center gap-1"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm0 16H5V5h14v14zM7 9h10v2H7zm0 4h6v2H7z" />
                  </svg>
                  <span>{selectedResolution.label.split(' ')[0]}</span>
                </button>

                {showResolutions && (
                  <div className="absolute bottom-full right-0 mb-2 bg-white rounded-2xl shadow-xl p-3 w-48 border border-gray-200 z-10">
                    <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2 px-2">Quality</p>
                    <div className="space-y-0.5 max-h-48 overflow-y-auto">
                      {availableResolutions.map(res => (
                        <button
                          key={`${res.width}x${res.height}`}
                          onClick={() => changeResolution(res)}
                          className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                            selectedResolution.width === res.width
                              ? 'bg-gray-900 text-white font-semibold'
                              : 'text-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          {res.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <span className="text-xs text-gray-200 font-mono flex-shrink-0 hidden sm:inline">
                🔒 {viewerId.slice(0, 10)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ViewerPage;