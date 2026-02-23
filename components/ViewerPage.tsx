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
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'turn:a.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
];

const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_DELAY = 1500;

type ConnectionStatus = 'connecting' | 'live' | 'ended' | 'reconnecting';

const ViewerPage: React.FC<ViewerPageProps> = ({ streamId }) => {
  // Connection state
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [reconnectIn, setReconnectIn] = useState(0);
  const [attemptCount, setAttemptCount] = useState(0);

  // Player state
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [theaterMode, setTheaterMode] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showVolume, setShowVolume] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [hasVideo, setHasVideo] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);
  const [videoResolution, setVideoResolution] = useState('');
  const [networkQuality, setNetworkQuality] = useState<'good' | 'fair' | 'poor'>('good');
  const [liveElapsed, setLiveElapsed] = useState(0);
  const [showPipSupport] = useState(typeof document !== 'undefined' && 'pictureInPictureEnabled' in document);
  const [pip, setPip] = useState(false);

  // Refs (stable across renders, no stale closures)
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<any>(null);
  const callRef = useRef<any>(null);
  const controlsTimer = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const statusRef = useRef<ConnectionStatus>('connecting');
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectCountdownRef = useRef<number | null>(null);
  const statsIntervalRef = useRef<number | null>(null);
  const liveElapsedRef = useRef<number | null>(null);
  const liveStartRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioAnimRef = useRef<number | null>(null);

  const adminPeerId = `${PEER_PREFIX}${streamId}`;

  // ── Status helpers ────────────────────────────────────────────────────────
  const setStatusSafe = useCallback((s: ConnectionStatus) => {
    statusRef.current = s;
    if (mountedRef.current) setStatus(s);
  }, []);

  // ── Audio monitoring ──────────────────────────────────────────────────────
  const startAudioMonitoring = useCallback((stream: MediaStream) => {
    if (!stream.getAudioTracks().length) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.85;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length / 255;
        if (mountedRef.current) setAudioLevel(avg);
        audioAnimRef.current = requestAnimationFrame(tick);
      };
      audioAnimRef.current = requestAnimationFrame(tick);
    } catch {}
  }, []);

  const stopAudioMonitoring = useCallback(() => {
    if (audioAnimRef.current) { cancelAnimationFrame(audioAnimRef.current); audioAnimRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close().catch(() => {}); audioContextRef.current = null; }
    setAudioLevel(0);
  }, []);

  // ── Stats monitoring ──────────────────────────────────────────────────────
  const startStats = useCallback(() => {
    if (statsIntervalRef.current) return;
    statsIntervalRef.current = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || !video.srcObject) return;
      if (video.videoWidth && video.videoHeight) {
        setVideoResolution(`${video.videoWidth}×${video.videoHeight}`);
      }
      // Network quality from buffer
      if (video.buffered.length > 0) {
        const ahead = video.buffered.end(video.buffered.length - 1) - video.currentTime;
        if (mountedRef.current) {
          setNetworkQuality(ahead < 0.5 ? 'poor' : ahead < 2 ? 'fair' : 'good');
        }
      }
    }, 2000);
  }, []);

  const stopStats = useCallback(() => {
    if (statsIntervalRef.current) { clearInterval(statsIntervalRef.current); statsIntervalRef.current = null; }
  }, []);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    stopStats();
    stopAudioMonitoring();
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    if (reconnectCountdownRef.current) { clearInterval(reconnectCountdownRef.current); reconnectCountdownRef.current = null; }
    if (liveElapsedRef.current) { clearInterval(liveElapsedRef.current); liveElapsedRef.current = null; }
    if (callRef.current) { try { callRef.current.close(); } catch {} callRef.current = null; }
    if (peerRef.current) { try { peerRef.current.destroy(); } catch {} peerRef.current = null; }
    if (videoRef.current) { videoRef.current.srcObject = null; }
  }, [stopStats, stopAudioMonitoring]);

  // ── Reconnect with countdown ──────────────────────────────────────────────
  const scheduleReconnect = useCallback((connectFn: () => void) => {
    const attempt = reconnectAttemptsRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setStatusSafe('ended');
      setErrorMsg('Could not connect to stream after multiple attempts.');
      return;
    }
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(1.5, attempt), 15000);
    const seconds = Math.ceil(delay / 1000);
    setReconnectIn(seconds);
    setStatusSafe('reconnecting');

    // Countdown display
    if (reconnectCountdownRef.current) clearInterval(reconnectCountdownRef.current);
    reconnectCountdownRef.current = window.setInterval(() => {
      setReconnectIn(prev => {
        if (prev <= 1) {
          if (reconnectCountdownRef.current) clearInterval(reconnectCountdownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    reconnectTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) connectFn();
    }, delay);
  }, [setStatusSafe]);

  // ── Core connection ───────────────────────────────────────────────────────
  const connectToBroadcaster = useCallback(() => {
    if (!mountedRef.current) return;

    // Clean up previous connection attempt
    if (callRef.current) { try { callRef.current.close(); } catch {} callRef.current = null; }
    if (peerRef.current) { try { peerRef.current.destroy(); } catch {} peerRef.current = null; }

    reconnectAttemptsRef.current += 1;
    setAttemptCount(reconnectAttemptsRef.current);
    setStatusSafe('connecting');
    setErrorMsg('');

    const viewerId = `v-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;

    let peer: any;
    try {
      peer = new Peer(viewerId, {
        config: {
          iceServers: ICE_SERVERS,
          iceTransportPolicy: 'all',
          iceCandidatePoolSize: 12,
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require',
        },
        debug: 0
      });
    } catch (err) {
      console.error('[Viewer] Failed to create Peer:', err);
      scheduleReconnect(connectToBroadcaster);
      return;
    }

    peerRef.current = peer;

    // Connection timeout — use a ref to capture "did we connect"
    const didConnect = { current: false };
    const timeout = window.setTimeout(() => {
      if (!didConnect.current && mountedRef.current) {
        console.warn('[Viewer] Connection timeout, retrying…');
        peer.destroy();
        scheduleReconnect(connectToBroadcaster);
      }
    }, 12000);

    peer.on('open', () => {
      if (!mountedRef.current) { peer.destroy(); return; }
      console.log('[Viewer] Peer opened, calling broadcaster…');

      // Call the broadcaster with an empty stream (we only want to receive)
      let call: any;
      try {
        call = peer.call(adminPeerId, new MediaStream(), {
          // Offer to receive both audio and video
          sdpTransform: (sdp: string) => sdp
        });
      } catch (e) {
        console.error('[Viewer] Call failed:', e);
        clearTimeout(timeout);
        scheduleReconnect(connectToBroadcaster);
        return;
      }

      callRef.current = call;

      const callTimeout = window.setTimeout(() => {
        if (!didConnect.current && mountedRef.current) {
          console.warn('[Viewer] Call timeout, retrying…');
          call.close();
          peer.destroy();
          scheduleReconnect(connectToBroadcaster);
        }
      }, 8000);

      call.on('stream', (remoteStream: MediaStream) => {
        clearTimeout(timeout);
        clearTimeout(callTimeout);
        didConnect.current = true;

        if (!mountedRef.current) return;

        const vTracks = remoteStream.getVideoTracks();
        const aTracks = remoteStream.getAudioTracks();
        const gotVideo = vTracks.length > 0;
        const gotAudio = aTracks.length > 0;

        console.log(`[Viewer] Stream received — video: ${gotVideo}, audio: ${gotAudio}`);

        setHasVideo(gotVideo);
        setHasAudio(gotAudio);

        if (!gotVideo && !gotAudio) {
          console.warn('[Viewer] Empty stream received, retrying…');
          scheduleReconnect(connectToBroadcaster);
          return;
        }

        if (videoRef.current) {
          videoRef.current.srcObject = remoteStream;

          videoRef.current.play()
            .then(() => {
              if (!mountedRef.current) return;
              setPlaying(true);
              setStatusSafe('live');
              reconnectAttemptsRef.current = 0;
              setAttemptCount(0);

              // Start live timer
              liveStartRef.current = Date.now();
              if (liveElapsedRef.current) clearInterval(liveElapsedRef.current);
              liveElapsedRef.current = window.setInterval(() => {
                if (mountedRef.current) setLiveElapsed(Math.floor((Date.now() - liveStartRef.current) / 1000));
              }, 1000);

              startStats();
            })
            .catch(err => {
              console.warn('[Viewer] Autoplay blocked:', err);
              // User needs to interact — still mark as live so play button shows
              if (mountedRef.current) {
                setStatusSafe('live');
                setPlaying(false);
              }
            });
        }

        if (gotAudio) startAudioMonitoring(remoteStream);

        // Track individual track ended events (stream replacement)
        vTracks.forEach(track => {
          track.addEventListener('ended', () => {
            if (mountedRef.current && statusRef.current === 'live') {
              console.log('[Viewer] Video track ended');
              setStatusSafe('ended');
              setErrorMsg('Broadcast ended');
              cleanup();
            }
          });
        });

        // Monitor connection state
        const pc = call.peerConnection;
        if (pc) {
          pc.addEventListener('connectionstatechange', () => {
            const state = pc.connectionState;
            console.log('[Viewer] PC state:', state);
            if (!mountedRef.current) return;
            if (state === 'failed') {
              setNetworkQuality('poor');
              if (statusRef.current === 'live') {
                scheduleReconnect(connectToBroadcaster);
              }
            } else if (state === 'disconnected') {
              setNetworkQuality('poor');
            } else if (state === 'connected') {
              setNetworkQuality('good');
            }
          });

          pc.addEventListener('iceconnectionstatechange', () => {
            const state = pc.iceConnectionState;
            if (state === 'disconnected' || state === 'failed') {
              if (mountedRef.current && statusRef.current === 'live') {
                setNetworkQuality('poor');
              }
            }
          });
        }
      });

      call.on('close', () => {
        clearTimeout(callTimeout);
        console.log('[Viewer] Call closed');
        if (mountedRef.current && statusRef.current === 'live') {
          stopStats();
          stopAudioMonitoring();
          if (liveElapsedRef.current) clearInterval(liveElapsedRef.current);
          setStatusSafe('ended');
          setErrorMsg('Broadcast has ended');
        }
      });

      call.on('error', (err: any) => {
        clearTimeout(callTimeout);
        console.warn('[Viewer] Call error:', err);
        if (mountedRef.current) {
          if (!didConnect.current) {
            scheduleReconnect(connectToBroadcaster);
          } else if (statusRef.current === 'live') {
            scheduleReconnect(connectToBroadcaster);
          }
        }
      });
    });

    peer.on('error', (err: any) => {
      clearTimeout(timeout);
      console.warn('[Viewer] Peer error:', err.type);
      if (!mountedRef.current) return;

      if (err.type === 'peer-unavailable') {
        // Broadcaster not online yet, retry with backoff
        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          scheduleReconnect(connectToBroadcaster);
        } else {
          setStatusSafe('ended');
          setErrorMsg('Stream is not live. The broadcaster may have ended the stream.');
        }
      } else if (err.type === 'network' || err.type === 'disconnected' || err.type === 'socket-error') {
        scheduleReconnect(connectToBroadcaster);
      } else {
        scheduleReconnect(connectToBroadcaster);
      }
    });

    peer.on('disconnected', () => {
      console.warn('[Viewer] Peer disconnected');
      if (!mountedRef.current) return;
      if (statusRef.current === 'live') {
        setNetworkQuality('poor');
        scheduleReconnect(connectToBroadcaster);
      }
    });
  }, [adminPeerId, cleanup, scheduleReconnect, setStatusSafe, startAudioMonitoring, startStats, stopAudioMonitoring, stopStats]);

  // ── Initialize ────────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    reconnectAttemptsRef.current = 0;
    connectToBroadcaster();

    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    const onPipChange = () => setPip(!!document.pictureInPictureElement);
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('enterpictureinpicture', onPipChange);
    document.addEventListener('leavepictureinpicture', onPipChange);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('enterpictureinpicture', onPipChange);
      document.removeEventListener('leavepictureinpicture', onPipChange);
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
      cleanup();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Video events ──────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => { if (mountedRef.current) setPlaying(true); };
    const onPause = () => { if (mountedRef.current) setPlaying(false); };
    const onVolumeChange = () => {
      if (mountedRef.current) { setMuted(video.muted); setVolume(video.volume); }
    };
    const onWaiting = () => { if (mountedRef.current) setIsBuffering(true); };
    const onPlaying = () => { if (mountedRef.current) { setIsBuffering(false); setStatusSafe('live'); } };
    const onError = () => {
      if (mountedRef.current && statusRef.current === 'live') {
        scheduleReconnect(connectToBroadcaster);
      }
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('error', onError);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('error', onError);
    };
  }, [connectToBroadcaster, scheduleReconnect, setStatusSafe]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.code) {
        case 'Space': e.preventDefault(); togglePlay(); break;
        case 'KeyM': toggleMute(); break;
        case 'KeyF': toggleFullscreen(); break;
        case 'KeyT': setTheaterMode(prev => !prev); break;
        case 'KeyI': if (showPipSupport) togglePip(); break;
        case 'ArrowUp': e.preventDefault(); changeVolume(Math.min(1, volume + 0.1)); break;
        case 'ArrowDown': e.preventDefault(); changeVolume(Math.max(0, volume - 0.1)); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [volume, showPipSupport]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Controls ──────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }, []);

  const toggleMute = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setMuted(videoRef.current.muted);
    }
  }, []);

  const changeVolume = useCallback((val: number) => {
    if (videoRef.current) {
      const v = Math.max(0, Math.min(1, val));
      videoRef.current.volume = v;
      videoRef.current.muted = v === 0;
      setVolume(v);
      setMuted(v === 0);
    }
  }, []);

  const changePlaybackRate = useCallback((rate: number) => {
    if (videoRef.current) { videoRef.current.playbackRate = rate; setPlaybackRate(rate); }
    setShowSettings(false);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    try {
      if (!document.fullscreenElement) await containerRef.current.requestFullscreen();
      else await document.exitFullscreen();
    } catch {}
  }, []);

  const togglePip = useCallback(async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await (videoRef.current as any).requestPictureInPicture();
    } catch (e) { console.warn('PiP error:', e); }
  }, []);

  const resetControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = window.setTimeout(() => {
      setShowControls(false);
      setShowVolume(false);
      setShowSettings(false);
    }, 3500);
  }, []);

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const volumePercent = (muted ? 0 : volume) * 100;

  // ── Render: Ended ─────────────────────────────────────────────────────────
  if (status === 'ended') {
    return (
      <div className="min-h-screen bg-[#0f0f0f] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-24 h-24 mx-auto bg-white/5 rounded-3xl flex items-center justify-center border border-white/10">
            <svg className="w-12 h-12 text-white/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Stream Ended</h2>
            <p className="text-white/40 mt-2 text-sm">{errorMsg || 'The broadcast has ended'}</p>
          </div>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => {
                reconnectAttemptsRef.current = 0;
                connectToBroadcaster();
              }}
              className="px-6 py-2.5 bg-white/10 text-white border border-white/20 rounded-full text-sm font-medium hover:bg-white/15 transition-colors"
            >
              Try Reconnecting
            </button>
            <button
              onClick={() => window.location.hash = '#/'}
              className="px-6 py-2.5 bg-red-600 text-white rounded-full text-sm font-medium hover:bg-red-700 transition-colors"
            >
              Go Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Player ────────────────────────────────────────────────────────
  return (
    <div className={`bg-black ${theaterMode ? 'min-h-screen' : 'min-h-screen'}`}>
      <div
        ref={containerRef}
        className={`relative bg-black group ${
          fullscreen
            ? 'fixed inset-0 z-50'
            : theaterMode
            ? 'w-full'
            : 'w-full'
        }`}
        style={{ aspectRatio: fullscreen ? undefined : '16/9' }}
        onMouseMove={resetControls}
        onClick={() => {
          if (status === 'live' && !showSettings) {
            resetControls();
          }
        }}
        onDoubleClick={toggleFullscreen}
        onMouseLeave={() => {
          if (controlsTimer.current) clearTimeout(controlsTimer.current);
          controlsTimer.current = window.setTimeout(() => {
            setShowControls(false);
            setShowVolume(false);
            setShowSettings(false);
          }, 1200);
        }}
      >
        {/* Video */}
        <video
          ref={videoRef}
          className="w-full h-full object-contain bg-black"
          playsInline
          style={{ display: 'block' }}
        />

        {/* ── Connecting overlay ──────────────────────────────────────────── */}
        {(status === 'connecting' || status === 'reconnecting') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0f0f0f]">
            <div className="text-center space-y-4 max-w-sm px-6">
              {/* Animated logo */}
              <div className="w-16 h-16 mx-auto relative">
                <div className="absolute inset-0 border-4 border-white/10 rounded-full" />
                <div className="absolute inset-0 border-4 border-t-white border-r-transparent border-b-transparent border-l-transparent rounded-full spin" />
                <div className="absolute inset-3 flex items-center justify-center">
                  <svg className="w-6 h-6 text-white/40" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
              </div>

              <div>
                <p className="text-white font-semibold text-lg">
                  {status === 'reconnecting' ? 'Reconnecting…' : 'Connecting to stream…'}
                </p>
                <p className="text-white/40 text-sm mt-1">
                  {status === 'reconnecting'
                    ? `Retrying in ${reconnectIn}s (attempt ${attemptCount}/${MAX_RECONNECT_ATTEMPTS})`
                    : 'Establishing secure connection'}
                </p>
              </div>

              <p className="text-white/20 text-xs font-mono tracking-wider">
                {streamId.slice(0, 8)}…{streamId.slice(-4)}
              </p>

              {status === 'reconnecting' && (
                <button
                  onClick={() => {
                    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
                    if (reconnectCountdownRef.current) clearInterval(reconnectCountdownRef.current);
                    connectToBroadcaster();
                  }}
                  className="px-5 py-2 bg-white/10 hover:bg-white/20 rounded-full text-white text-sm transition-colors border border-white/10"
                >
                  Retry Now
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Buffering spinner ───────────────────────────────────────────── */}
        {isBuffering && status === 'live' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-14 h-14 relative">
              <div className="absolute inset-0 border-4 border-white/15 rounded-full" />
              <div className="absolute inset-0 border-4 border-t-white border-r-transparent border-b-transparent border-l-transparent rounded-full spin" />
            </div>
          </div>
        )}

        {/* ── Play overlay (when paused) ──────────────────────────────────── */}
        {hasVideo && !playing && !isBuffering && status === 'live' && (
          <div
            className="absolute inset-0 flex items-center justify-center cursor-pointer"
            onClick={e => { e.stopPropagation(); togglePlay(); }}
          >
            <div className="w-20 h-20 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center hover:bg-black/80 transition-all transform hover:scale-105 border border-white/20">
              <svg className="w-10 h-10 text-white ml-1" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}

        {/* ── Network quality warning ─────────────────────────────────────── */}
        {status === 'live' && networkQuality !== 'good' && (
          <div className={`absolute top-16 right-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium backdrop-blur-sm ${
            networkQuality === 'poor'
              ? 'bg-red-600/90 text-white'
              : 'bg-yellow-500/90 text-white'
          }`}>
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
            </svg>
            {networkQuality === 'poor' ? 'Poor connection' : 'Unstable connection'}
          </div>
        )}

        {/* ── Controls overlay ────────────────────────────────────────────── */}
        <div
          className={`absolute inset-0 flex flex-col justify-between transition-opacity duration-300 ${
            showControls || !playing ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          style={{ background: showControls || !playing ? 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 35%, rgba(0,0,0,0.4) 100%)' : 'transparent' }}
        >
          {/* Top bar */}
          <div className="p-4 flex items-center gap-3">
            {status === 'live' && (
              <>
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 rounded-full">
                  <span className="w-2 h-2 bg-white rounded-full live-dot" />
                  <span className="text-white text-xs font-bold tracking-wider">LIVE</span>
                </div>
                <span className="px-3 py-1.5 bg-black/50 backdrop-blur-sm rounded-full text-xs text-white font-mono">
                  {formatTime(liveElapsed)}
                </span>
                {videoResolution && (
                  <span className="hidden sm:block px-3 py-1.5 bg-black/50 backdrop-blur-sm rounded-full text-xs text-white/70">
                    {videoResolution}
                  </span>
                )}
              </>
            )}

            {/* Back button */}
            <button
              onClick={(e) => { e.stopPropagation(); window.location.hash = '#/'; }}
              className="ml-auto p-2 bg-black/50 backdrop-blur-sm rounded-full hover:bg-black/70 transition-colors"
            >
              <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          </div>

          {/* Bottom controls */}
          <div className="p-4 space-y-3" onClick={e => e.stopPropagation()}>

            {/* Controls row */}
            <div className="flex items-center gap-2">
              {/* Play/Pause */}
              <button onClick={togglePlay} className="text-white hover:text-white/80 transition-colors p-1">
                {playing ? (
                  <svg className="w-9 h-9" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg className="w-9 h-9" viewBox="0 0 24 24" fill="currentColor">
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
                <button onClick={toggleMute} className="text-white hover:text-white/80 transition-colors p-2">
                  {muted || volume === 0 ? (
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 19.73L19 21 20.27 19.73 5.54 5 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                    </svg>
                  ) : volume < 0.5 ? (
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                    </svg>
                  ) : (
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                    </svg>
                  )}
                </button>

                {/* Volume slider */}
                {showVolume && (
                  <div className="flex items-center gap-2 ml-1">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={muted ? 0 : volume}
                      onChange={e => changeVolume(parseFloat(e.target.value))}
                      className="volume-slider w-20 sm:w-28"
                      style={{ background: `linear-gradient(to right, white ${volumePercent}%, rgba(255,255,255,0.25) ${volumePercent}%)` }}
                    />
                    <span className="text-white/60 text-xs font-mono w-8">{Math.round(volumePercent)}%</span>
                  </div>
                )}
              </div>

              {/* Audio level bars */}
              {hasAudio && playing && status === 'live' && (
                <div className="hidden sm:flex items-end gap-0.5 h-5 ml-1">
                  {[0.15, 0.35, 0.55, 0.35, 0.15].map((threshold, i) => (
                    <div
                      key={i}
                      className={`w-1 rounded-full transition-all duration-75 ${
                        audioLevel > threshold
                          ? audioLevel > 0.8 ? 'bg-red-400' : 'bg-green-400'
                          : 'bg-white/20'
                      }`}
                      style={{ height: `${40 + i * 15 + (i > 2 ? (4 - i) * 15 : 0)}%` }}
                    />
                  ))}
                </div>
              )}

              <div className="flex-1" />

              {/* Keyboard shortcuts hint */}
              {status === 'live' && (
                <span className="hidden lg:block text-white/30 text-xs">
                  Space · M · F · T
                </span>
              )}

              {/* Theater mode */}
              <button
                onClick={() => setTheaterMode(prev => !prev)}
                className="p-2 text-white/70 hover:text-white transition-colors hidden sm:block"
                title="Theater mode (T)"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  {theaterMode
                    ? <path d="M22 7H2v10h20V7zm-2 8H4V9h16v6z" />
                    : <path d="M19 7H5c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zm0 8H5V9h14v6z" />
                  }
                </svg>
              </button>

              {/* Picture-in-picture */}
              {showPipSupport && (
                <button
                  onClick={togglePip}
                  className="p-2 text-white/70 hover:text-white transition-colors hidden sm:block"
                  title="Picture in picture (I)"
                >
                  {pip ? (
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 11h-8v6h8v-6zm4 10V2.98C23 1.88 22.1 1 21 1H3C1.9 1 1 1.88 1 2.98V21c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V3h18v18.02z" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 7H5c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zm0 12H5V9h14v10zm-8-4h6v-4h-6v4z" />
                    </svg>
                  )}
                </button>
              )}

              {/* Settings */}
              <div className="relative">
                <button
                  onClick={() => setShowSettings(prev => !prev)}
                  className={`p-2 transition-colors ${showSettings ? 'text-white' : 'text-white/70 hover:text-white'}`}
                  title="Settings"
                >
                  <svg className={`w-5 h-5 transition-transform ${showSettings ? 'rotate-45' : ''}`} viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                  </svg>
                </button>

                {showSettings && (
                  <div className="absolute bottom-full right-0 mb-3 w-56 bg-[#1a1a1a] rounded-2xl shadow-2xl border border-white/10 overflow-hidden">
                    <div className="px-4 py-2.5 text-xs font-bold text-white/40 uppercase tracking-wider border-b border-white/10">
                      Playback Speed
                    </div>
                    <div className="grid grid-cols-3 gap-1 p-2">
                      {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                        <button
                          key={rate}
                          onClick={() => changePlaybackRate(rate)}
                          className={`px-2 py-2 text-xs rounded-xl font-semibold transition-colors ${
                            playbackRate === rate
                              ? 'bg-red-600 text-white'
                              : 'text-white/60 hover:bg-white/10 hover:text-white'
                          }`}
                        >
                          {rate === 1 ? 'Normal' : `${rate}×`}
                        </button>
                      ))}
                    </div>
                    <div className="px-4 py-2.5 text-xs font-bold text-white/40 uppercase tracking-wider border-t border-white/10">
                      Shortcuts
                    </div>
                    <div className="p-3 space-y-1.5">
                      {[
                        ['Space', 'Play/Pause'],
                        ['M', 'Mute'],
                        ['F', 'Fullscreen'],
                        ['T', 'Theater'],
                        ['↑/↓', 'Volume'],
                      ].map(([key, label]) => (
                        <div key={key} className="flex items-center justify-between text-xs">
                          <span className="text-white/40">{label}</span>
                          <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-white/60 font-mono">{key}</kbd>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Fullscreen */}
              <button onClick={toggleFullscreen} className="p-2 text-white/70 hover:text-white transition-colors" title="Fullscreen (F)">
                {fullscreen ? (
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M15 9h4.5M15 9V4.5M9 15v4.5M9 15H4.5M15 15h4.5M15 15v4.5" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Info bar below player (non-fullscreen) */}
      {!fullscreen && (
        <div className="bg-[#0f0f0f] border-t border-white/5 px-4 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-red-600 rounded-full flex items-center justify-center">
              <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Live Stream</p>
              <p className="text-xs text-white/40 font-mono">{streamId.slice(0, 12)}…</p>
            </div>
          </div>

          <div className="flex items-center gap-3 ml-auto text-xs text-white/40">
            {status === 'live' && videoResolution && (
              <span className="px-2 py-1 bg-white/5 rounded-full">{videoResolution}</span>
            )}
            {status === 'live' && (
              <span className="flex items-center gap-1.5 px-2 py-1 bg-red-900/30 rounded-full text-red-400">
                <span className="w-1.5 h-1.5 bg-red-500 rounded-full live-dot" />
                {formatTime(liveElapsed)}
              </span>
            )}
            <div className="flex items-center gap-1">
              {['good', 'fair', 'poor'].map((level, i) => (
                <div
                  key={level}
                  className={`rounded-sm ${i === 0 ? 'h-2.5' : i === 1 ? 'h-3.5' : 'h-5'} w-1.5 ${
                    networkQuality === 'good' ? 'bg-green-500' :
                    networkQuality === 'fair' && i < 2 ? 'bg-yellow-400' :
                    networkQuality === 'poor' && i === 0 ? 'bg-red-500' :
                    'bg-white/15'
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ViewerPage;
