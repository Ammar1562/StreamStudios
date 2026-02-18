// ViewerPage.tsx
import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { StreamMode, Resolution } from '../types';

interface ViewerPageProps {
  streamId: string;
}

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) return '0:00';
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = Math.floor(s % 60);
  
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const HEARTBEAT_INTERVAL = 5000;

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
  const [buffered, setBuffered] = useState(0);
  const [showVolume, setShowVolume] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [pip, setPip] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectedResolution, setSelectedResolution] = useState<Resolution>(VIEWER_RESOLUTIONS[3]);
  const [availableResolutions, setAvailableResolutions] = useState<Resolution[]>(VIEWER_RESOLUTIONS);
  const [showResolutions, setShowResolutions] = useState(false);
  const [stats, setStats] = useState<{ bitrate: number; fps: number } | null>(null);
  const [isLiveStream, setIsLiveStream] = useState(true);
  const [liveLatency, setLiveLatency] = useState(0);
  const [showLiveIndicator, setShowLiveIndicator] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const playPromiseRef = useRef<Promise<void> | null>(null);
  const controlsTimer = useRef<number | null>(null);
  const streamInfoRef = useRef<typeof streamInfo>(null);
  const heartbeatTimer = useRef<number | null>(null);
  const statsTimer = useRef<number | null>(null);
  const lastLiveTimeRef = useRef<number>(Date.now());
  const liveCheckTimer = useRef<number | null>(null);
  const reconnectTimer = useRef<number | null>(null);

  const viewerId = useMemo(
    () => `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
    []
  );

  // Safe play with better error handling
  const safePlay = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return false;
    
    try {
      // Cancel any existing play promise
      if (playPromiseRef.current) {
        await playPromiseRef.current.catch(() => {});
        playPromiseRef.current = null;
      }
      
      // Only try to play if paused
      if (v.paused) {
        playPromiseRef.current = v.play();
        await playPromiseRef.current;
        setPlaying(true);
        return true;
      }
      return true;
    } catch (e: any) {
      // Ignore abort errors (from rapid play/pause)
      if (e.name !== 'AbortError') {
        console.warn('Play error:', e);
      }
      return false;
    } finally {
      playPromiseRef.current = null;
    }
  }, []);

  // Safe pause
  const safePause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    
    try {
      v.pause();
      setPlaying(false);
    } catch (e) {
      console.error('Pause error:', e);
    }
  }, []);

  // Toggle play/pause
  const togglePlay = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    
    if (v.paused) {
      await safePlay();
    } else {
      safePause();
    }
  }, [safePlay, safePause]);

  // Toggle mute
  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  // Change volume
  const changeVolume = useCallback((val: number) => {
    const v = videoRef.current;
    if (!v) return;
    
    v.volume = val;
    v.muted = val === 0;
    setVolume(val);
    setMuted(val === 0);
  }, []);

  // Change playback rate
  const changePlaybackRate = useCallback((rate: number) => {
    const v = videoRef.current;
    if (!v) return;
    
    v.playbackRate = rate;
    setPlaybackRate(rate);
    setShowSettings(false);
  }, []);

  // Change resolution
  const changeResolution = useCallback((resolution: Resolution) => {
    setSelectedResolution(resolution);
    setShowResolutions(false);
    
    // Request stream with new resolution
    if (pcRef.current && streamId && bcRef.current) {
      bcRef.current.postMessage({
        type: 'VIEWER_JOIN',
        payload: { streamId, viewerId, resolution }
      });
    }
  }, [streamId, viewerId]);

  // Seek
  const seek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v || !duration || isLiveStream) return;
    
    v.currentTime = parseFloat(e.target.value);
  }, [duration, isLiveStream]);

  // Seek to live
  const seekToLive = useCallback(() => {
    const v = videoRef.current;
    if (!v || !isLiveStream) return;
    
    // For live streams, we can't seek forward, but we can ensure we're playing
    if (v.paused) {
      safePlay();
    }
    
    setShowLiveIndicator(false);
  }, [isLiveStream, safePlay]);

  // Toggle fullscreen
  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (e) {
      console.error('Fullscreen error:', e);
    }
  }, []);

  // Toggle picture-in-picture
  const togglePip = useCallback(async () => {
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
    } catch (e) {
      console.error('PiP error:', e);
    }
  }, []);

  // Reset controls timer
  const resetControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = window.setTimeout(() => {
      setShowControls(false);
      setShowVolume(false);
      setShowSettings(false);
      setShowResolutions(false);
    }, 3500);
  }, []);

  // Check live latency
  const checkLiveLatency = useCallback(() => {
    const v = videoRef.current;
    if (!v || !isLiveStream || !v.buffered.length) return;
    
    try {
      const bufferedEnd = v.buffered.end(v.buffered.length - 1);
      const current = v.currentTime;
      const latency = bufferedEnd - current;
      
      setLiveLatency(latency);
      
      // Show live indicator if latency > 2 seconds and video is playing
      if (latency > 2 && !v.paused && isLiveStream) {
        setShowLiveIndicator(true);
      } else {
        setShowLiveIndicator(false);
      }
    } catch (e) {
      // Ignore buffered range errors
    }
  }, [isLiveStream]);

  // Update stats
  const updateStats = useCallback(() => {
    if (!pcRef.current || !videoRef.current) return;
    
    try {
      const videoTrack = videoRef.current.srcObject instanceof MediaStream
        ? videoRef.current.srcObject.getVideoTracks()[0]
        : null;
      
      if (videoTrack && 'getStats' in pcRef.current) {
        (pcRef.current as any).getStats().then((reports: any) => {
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
    } catch (e) {
      // Ignore stats errors
    }
  }, []);

  // Main effect for WebRTC and BroadcastChannel
  useEffect(() => {
    console.log('Viewer mounting with ID:', viewerId, 'Stream ID:', streamId);
    
    // Create BroadcastChannel
    const bc = new BroadcastChannel('secure_stream_channel');
    bcRef.current = bc;

    // Create RTCPeerConnection
    const createPeerConnection = () => {
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });

      // Handle ICE candidates
      pc.onicecandidate = (e) => {
        if (e.candidate && bcRef.current) {
          bcRef.current.postMessage({ 
            type: 'SIGNAL_ICE', 
            payload: { viewerId, candidate: e.candidate.toJSON() } 
          });
        }
      };

      // Handle connection state changes
      pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          setStatus('live');
          if (reconnectTimer.current) {
            clearTimeout(reconnectTimer.current);
            reconnectTimer.current = null;
          }
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setStatus('connecting');
          // Try to reconnect
          if (!reconnectTimer.current) {
            reconnectTimer.current = window.setTimeout(() => {
              if (bcRef.current) {
                bcRef.current.postMessage({ 
                  type: 'VIEWER_JOIN', 
                  payload: { streamId, viewerId } 
                });
              }
              reconnectTimer.current = null;
            }, 3000);
          }
        }
      };

      // Handle tracks
      pc.ontrack = (event) => {
        console.log('Received track:', event.track.kind);
        const v = videoRef.current;
        if (!v) return;
        
        // Set stream to video element
        v.srcObject = event.streams[0];
        setHasVideo(true);
        setStatus('live');
        
        // Determine if this is a live stream or file upload
        // For WebRTC, it's always live
        setIsLiveStream(true);
        
        // Try to play
        safePlay().catch(console.warn);
        
        // Start stats collection
        if (statsTimer.current) clearInterval(statsTimer.current);
        statsTimer.current = window.setInterval(updateStats, 2000);
      };

      pcRef.current = pc;
      return pc;
    };

    // Handle WebRTC offer
    const handleOffer = async (
      offer: RTCSessionDescriptionInit,
      offerStreamId: string,
      title: string,
      mode: StreamMode,
      streamResolution?: Resolution
    ) => {
      if (offerStreamId !== streamId) return;
      
      console.log('Received offer for stream:', offerStreamId);
      
      // Close existing connection
      if (pcRef.current) {
        pcRef.current.close();
      }

      // Create new connection
      const pc = createPeerConnection();

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log('Set remote description');
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log('Created and set local description');
        
        // Send answer back to admin
        if (bcRef.current) {
          bcRef.current.postMessage({ 
            type: 'SIGNAL_ANSWER', 
            payload: { viewerId, answer } 
          });
        }

        // Update stream info
        const info = { title, mode };
        streamInfoRef.current = info;
        setStreamInfo(info);
        
        // Update available resolutions
        if (streamResolution) {
          setAvailableResolutions(prev => {
            const exists = prev.some(r => r.width === streamResolution.width);
            if (!exists) {
              return [...prev, streamResolution];
            }
            return prev;
          });
        }
      } catch (e) {
        console.error('Error handling offer:', e);
      }
    };

    // Handle messages from admin
    bc.onmessage = async (event) => {
      const { type, payload } = event.data;
      console.log('Received message:', type, payload);

      // Filter messages for this viewer
      if (payload?.viewerId && payload.viewerId !== viewerId && type !== 'STOP_STREAM') return;

      switch (type) {
        case 'STREAM_UPDATE':
          if (payload.streamId === streamId) {
            const info = { title: payload.title, mode: payload.mode };
            streamInfoRef.current = info;
            setStreamInfo(info);
            setStatus('live');
            
            // Check if this is a file upload
            setIsLiveStream(payload.mode !== StreamMode.FILE_UPLOAD);
            
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
          await handleOffer(
            payload.offer, 
            payload.streamId, 
            payload.title, 
            payload.mode, 
            payload.resolution
          );
          break;
          
        case 'SIGNAL_ICE_ADMIN':
          if (pcRef.current && payload.candidate) {
            try {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
            } catch (e) {
              console.warn('Error adding ICE candidate:', e);
            }
          }
          break;
          
        case 'STOP_STREAM':
          streamInfoRef.current = null;
          setStreamInfo(null);
          setStatus('ended');
          setErrorMsg('The broadcast has ended.');
          setHasVideo(false);
          
          if (pcRef.current) {
            pcRef.current.close();
            pcRef.current = null;
          }
          
          if (heartbeatTimer.current) {
            clearInterval(heartbeatTimer.current);
          }
          
          if (statsTimer.current) {
            clearInterval(statsTimer.current);
          }
          
          // Clear video
          if (videoRef.current) {
            videoRef.current.srcObject = null;
          }
          break;
      }
    };

    // Announce presence
    const announce = () => {
      if (bcRef.current) {
        bcRef.current.postMessage({ 
          type: 'VIEWER_JOIN', 
          payload: { streamId, viewerId } 
        });
      }
    };
    
    announce();
    
    // Keep announcing until we get a response
    const joinInterval = setInterval(() => {
      if (!streamInfoRef.current && bcRef.current) {
        announce();
      } else {
        clearInterval(joinInterval);
      }
    }, 2000);

    // Send heartbeats
    heartbeatTimer.current = window.setInterval(() => {
      if (bcRef.current && streamInfoRef.current) {
        bcRef.current.postMessage({ 
          type: 'VIEWER_HEARTBEAT', 
          payload: { streamId, viewerId } 
        });
      }
    }, HEARTBEAT_INTERVAL);

    // Send leave message on unload
    const sendLeave = () => {
      if (bcRef.current) {
        bcRef.current.postMessage({ 
          type: 'VIEWER_LEAVE', 
          payload: { streamId, viewerId } 
        });
      }
    };
    
    window.addEventListener('beforeunload', sendLeave);
    window.addEventListener('pagehide', sendLeave);

    // Mouse movement for controls
    document.addEventListener('mousemove', resetControls);
    document.addEventListener('touchstart', resetControls);
    
    // Fullscreen change
    document.addEventListener('fullscreenchange', () => {
      setFullscreen(!!document.fullscreenElement);
    });
    
    resetControls();

    // Live latency check
    liveCheckTimer.current = window.setInterval(checkLiveLatency, 1000);

    // Cleanup
    return () => {
      console.log('Viewer unmounting');
      
      clearInterval(joinInterval);
      
      if (heartbeatTimer.current) {
        clearInterval(heartbeatTimer.current);
      }
      
      if (statsTimer.current) {
        clearInterval(statsTimer.current);
      }
      
      if (liveCheckTimer.current) {
        clearInterval(liveCheckTimer.current);
      }
      
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }

      sendLeave();
      
      if (bcRef.current) {
        bcRef.current.close();
      }
      
      if (pcRef.current) {
        pcRef.current.close();
      }

      window.removeEventListener('beforeunload', sendLeave);
      window.removeEventListener('pagehide', sendLeave);
      document.removeEventListener('mousemove', resetControls);
      document.removeEventListener('touchstart', resetControls);
      
      if (controlsTimer.current) {
        clearTimeout(controlsTimer.current);
      }
    };
  }, [streamId, viewerId, resetControls, checkLiveLatency, updateStats, safePlay]);

  // Video event listeners
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    
    const onTimeUpdate = () => {
      setCurrentTime(v.currentTime);
      checkLiveLatency();
    };
    
    const onLoadedMetadata = () => {
      const dur = v.duration || 0;
      setDuration(dur);
      
      // If duration is finite and > 0, it's likely a file
      if (isFinite(dur) && dur > 0) {
        setIsLiveStream(false);
      }
    };
    
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVolumeChange = () => {
      setMuted(v.muted);
      setVolume(v.volume);
    };
    
    const onProgress = () => {
      if (v.buffered.length > 0) {
        setBuffered(v.buffered.end(v.buffered.length - 1));
      }
    };
    
    const onWaiting = () => {
      // Show buffering indicator if needed
    };
    
    const onCanPlay = () => {
      // Video can play
    };
    
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('loadedmetadata', onLoadedMetadata);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('volumechange', onVolumeChange);
    v.addEventListener('progress', onProgress);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('canplay', onCanPlay);
    
    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('loadedmetadata', onLoadedMetadata);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('volumechange', onVolumeChange);
      v.removeEventListener('progress', onProgress);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('canplay', onCanPlay);
    };
  }, [checkLiveLatency]);

  // Calculate percentages
  const volPct = (muted ? 0 : volume) * 100;
  const seekPct = duration ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration ? (buffered / duration) * 100 : 0;

  // Ended screen
  if (status === 'ended') {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-4">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 bg-gray-800 rounded-2xl flex items-center justify-center mx-auto">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-white">Stream Ended</h2>
          <p className="text-gray-400 text-sm">{errorMsg}</p>
          <button
            onClick={() => (window.location.hash = '#/')}
            className="mt-4 px-6 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Video player container */}
      <div className="flex-1 flex items-center justify-center relative">
        <div
          ref={containerRef}
          className="relative w-full h-full"
          onMouseMove={resetControls}
          onMouseLeave={() => {
            if (controlsTimer.current) clearTimeout(controlsTimer.current);
            controlsTimer.current = window.setTimeout(() => setShowControls(false), 1000);
          }}
        >
          {/* Video element */}
          <video
            ref={videoRef}
            className="w-full h-full object-contain"
            playsInline
            onClick={togglePlay}
            onDoubleClick={toggleFullscreen}
          />

          {/* Connecting overlay */}
          {status === 'connecting' && !hasVideo && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black">
              <div className="relative w-16 h-16 mb-4">
                <div className="absolute inset-0 border-4 border-gray-800 rounded-full" />
                <div className="absolute inset-0 border-4 border-t-red-600 rounded-full animate-spin" />
              </div>
              <p className="text-gray-400 text-sm">Connecting to stream...</p>
              <p className="text-gray-600 text-xs mt-2 font-mono">{streamId}</p>
            </div>
          )}

          {/* Controls overlay */}
          <div
            className={`absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/30 transition-opacity duration-300 ${
              showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            {/* Top bar */}
            <div className="absolute top-0 left-0 right-0 p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => (window.location.hash = '#/')}
                  className="text-white/70 hover:text-white transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                
                {streamInfo?.title && (
                  <div>
                    <h1 className="text-white font-semibold text-sm sm:text-base truncate max-w-[200px] sm:max-w-[400px]">
                      {streamInfo.title}
                    </h1>
                    {status === 'live' && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="w-1.5 h-1.5 bg-red-600 rounded-full animate-pulse" />
                        <span className="text-red-500 text-xs font-medium uppercase tracking-wider">
                          {isLiveStream ? 'LIVE' : 'PREMIERE'}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-white/50 text-xs hidden sm:block">
                  {viewerId.slice(0, 8)}
                </span>
                <button
                  onClick={toggleFullscreen}
                  className="text-white/70 hover:text-white transition-colors p-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Live indicator when behind */}
            {showLiveIndicator && isLiveStream && (
              <div className="absolute top-20 left-1/2 transform -translate-x-1/2">
                <button
                  onClick={seekToLive}
                  className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-full text-sm font-semibold shadow-lg flex items-center gap-2 transition-colors"
                >
                  <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                  LIVE · {Math.round(liveLatency)}s behind
                </button>
              </div>
            )}

            {/* Bottom controls */}
            <div className="absolute bottom-0 left-0 right-0 p-4 space-y-2">
              {/* Progress bar */}
              <div className="relative group">
                <div className="flex items-center gap-2 text-white/70 text-xs">
                  <span className="tabular-nums">{fmt(currentTime)}</span>
                  
                  <div className="flex-1 relative h-1 bg-gray-600 rounded-full overflow-hidden">
                    {/* Buffered progress */}
                    <div
                      className="absolute h-full bg-gray-400"
                      style={{ width: `${bufferedPct}%` }}
                    />
                    
                    {/* Played progress */}
                    <div
                      className="absolute h-full bg-red-600"
                      style={{ width: `${seekPct}%` }}
                    />
                    
                    {/* Seek input */}
                    <input
                      type="range"
                      min={0}
                      max={duration || 100}
                      step={0.1}
                      value={currentTime}
                      onChange={seek}
                      disabled={isLiveStream}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-default"
                    />
                    
                    {/* Thumb (visible on hover) */}
                    <div
                      className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                      style={{ left: `${seekPct}%`, transform: 'translate(-50%, -50%)' }}
                    />
                  </div>
                  
                  <span className="tabular-nums">
                    {isLiveStream ? 'LIVE' : fmt(duration)}
                  </span>
                </div>
              </div>

              {/* Control buttons */}
              <div className="flex items-center gap-2">
                {/* Play/Pause */}
                <button
                  onClick={togglePlay}
                  className="text-white hover:text-white/80 transition-colors p-2"
                >
                  {playing ? (
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                  ) : (
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>

                {/* Volume */}
                <div
                  className="relative"
                  onMouseEnter={() => setShowVolume(true)}
                  onMouseLeave={() => setShowVolume(false)}
                >
                  <button
                    onClick={toggleMute}
                    className="text-white hover:text-white/80 transition-colors p-2"
                  >
                    {muted || volume === 0 ? (
                      <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 19.73L19 21 20.27 19.73 5.54 5 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                      </svg>
                    ) : volume < 0.5 ? (
                      <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                      </svg>
                    ) : (
                      <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                      </svg>
                    )}
                  </button>

                  {/* Volume slider */}
                  {showVolume && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-gray-900 rounded-lg p-3 shadow-xl">
                      <div className="relative h-24 w-6">
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.02}
                          value={muted ? 0 : volume}
                          onChange={(e) => changeVolume(parseFloat(e.target.value))}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                          style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                        />
                        <div className="absolute inset-0 bg-gray-700 rounded-full">
                          <div
                            className="absolute bottom-0 left-0 right-0 bg-white rounded-full"
                            style={{ height: `${volPct}%` }}
                          />
                        </div>
                      </div>
                      <div className="text-center text-white text-xs mt-1">
                        {Math.round(volPct)}%
                      </div>
                    </div>
                  )}
                </div>

                {/* Settings */}
                <div className="relative">
                  <button
                    onClick={() => setShowSettings(!showSettings)}
                    className="text-white hover:text-white/80 transition-colors p-2"
                  >
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                    </svg>
                  </button>

                  {showSettings && (
                    <div className="absolute bottom-full right-0 mb-2 bg-gray-900 rounded-lg p-3 w-48 shadow-xl">
                      <div className="text-white/70 text-xs font-semibold mb-2">Playback Speed</div>
                      <div className="space-y-1">
                        {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                          <button
                            key={rate}
                            onClick={() => changePlaybackRate(rate)}
                            className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                              playbackRate === rate
                                ? 'bg-red-600 text-white'
                                : 'text-white/70 hover:bg-gray-800'
                            }`}
                          >
                            {rate === 1 ? 'Normal' : `${rate}×`}
                          </button>
                        ))}
                      </div>

                      <div className="text-white/70 text-xs font-semibold mt-3 mb-2">Quality</div>
                      <div className="space-y-1">
                        {availableResolutions.map(res => (
                          <button
                            key={`${res.width}x${res.height}`}
                            onClick={() => changeResolution(res)}
                            className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                              selectedResolution.width === res.width
                                ? 'bg-red-600 text-white'
                                : 'text-white/70 hover:bg-gray-800'
                            }`}
                          >
                            {res.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Stats (if available) */}
                {stats && stats.bitrate > 0 && (
                  <div className="text-white/50 text-xs ml-auto">
                    {Math.round(stats.bitrate / 1000)} kbps
                  </div>
                )}

                {/* PiP (if supported) */}
                {typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && (
                  <button
                    onClick={togglePip}
                    className={`text-white hover:text-white/80 transition-colors p-2 ${
                      pip ? 'text-red-500' : ''
                    }`}
                  >
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z" />
                    </svg>
                  </button>
                )}

                {/* Fullscreen */}
                <button
                  onClick={toggleFullscreen}
                  className="text-white hover:text-white/80 transition-colors p-2"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ViewerPage;
