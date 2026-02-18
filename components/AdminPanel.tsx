import React, { useState, useRef, useEffect } from 'react';
import { StreamMode, VideoDevice, AudioDevice, Resolution, StreamMessage, StreamMessageType } from '../types';

const AI_TIPS = [
  'Lighting in front of you dramatically improves video clarity.',
  'A wired connection is more reliable than Wi-Fi for streaming.',
  'Test audio levels before going live — bad audio loses viewers fast.',
  'Keep your title concise and descriptive.',
];
const getRandomTip = () => AI_TIPS[Math.floor(Math.random() * AI_TIPS.length)];

const buildViewerUrl = (id: string) => {
  const base = window.location.origin + window.location.pathname;
  return `${base}#/viewer/${id}`;
};

const VIEWER_TIMEOUT = 12000;

const RESOLUTIONS: Resolution[] = [
  { width: 640, height: 480, label: '480p (SD)' },
  { width: 854, height: 480, label: '480p (16:9)' },
  { width: 960, height: 540, label: '540p' },
  { width: 1280, height: 720, label: '720p (HD)' },
  { width: 1920, height: 1080, label: '1080p (Full HD)' },
];

const AdminPanel: React.FC = () => {
  const [streamTitle, setStreamTitle] = useState('Title');
  const [mode, setMode] = useState<StreamMode>(StreamMode.IDLE);
  const [viewerMap, setViewerMap] = useState<Map<string, number>>(new Map());
  const [streamUrl, setStreamUrl] = useState('');
  const [streamId, setStreamId] = useState('');
  const [tip, setTip] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  // Device and resolution states
  const [videoDevices, setVideoDevices] = useState<VideoDevice[]>([]);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [selectedVideoDevice, setSelectedVideoDevice] = useState('');
  const [selectedAudioDevice, setSelectedAudioDevice] = useState('');
  const [selectedResolution, setSelectedResolution] = useState<Resolution>(RESOLUTIONS[3]); // 720p default
  const [showDeviceMenu, setShowDeviceMenu] = useState(false);

  // Single preview controls
  const [isPlaying, setIsPlaying] = useState(true);
  const [previewVolume, setPreviewVolume] = useState(0);
  const [previewMuted, setPreviewMuted] = useState(true);
  const [isFileUploading, setIsFileUploading] = useState(false);

  const streamTitleRef = useRef(streamTitle);
  const modeRef = useRef(mode);
  const streamIdRef = useRef('');
  const viewerMapRef = useRef<Map<string, number>>(new Map());

  const videoRef = useRef<HTMLVideoElement>(null); // Single preview video
  const streamRef = useRef<MediaStream | null>(null);
  const bc = useRef<BroadcastChannel | null>(null);
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const playPromiseRef = useRef<Promise<void> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stalePruneTimer = useRef<number | null>(null);
  const fileVideoRef = useRef<HTMLVideoElement | null>(null); // Hidden video element for file playback

  useEffect(() => { streamTitleRef.current = streamTitle; }, [streamTitle]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { streamIdRef.current = streamId; }, [streamId]);

  // Load available devices
  useEffect(() => {
    const getDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        
        const videos = devices
          .filter(d => d.kind === 'videoinput')
          .map(d => ({ deviceId: d.deviceId, label: d.label || `Camera ${videoDevices.length + 1}` }));
        
        const audios = devices
          .filter(d => d.kind === 'audioinput')
          .map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone ${audioDevices.length + 1}` }));

        setVideoDevices(videos);
        setAudioDevices(audios);

        if (videos.length > 0 && !selectedVideoDevice) setSelectedVideoDevice(videos[0].deviceId);
        if (audios.length > 0 && !selectedAudioDevice) setSelectedAudioDevice(audios[0].deviceId);
      } catch (err) {
        console.error('Error accessing media devices:', err);
      }
    };

    getDevices();

    navigator.mediaDevices.addEventListener('devicechange', getDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', getDevices);
  }, []);

  // Safe play function with proper error handling
  const safePlay = async (videoElement: HTMLVideoElement | null, promiseRef: React.MutableRefObject<Promise<void> | null>) => {
    if (!videoElement) return false;
    
    try {
      if (promiseRef.current) {
        await promiseRef.current.catch(() => {});
      }
      
      if (videoElement.paused) {
        promiseRef.current = videoElement.play();
        await promiseRef.current;
        return true;
      }
      return true;
    } catch (e: any) {
      if (e.name !== 'AbortError' && e.name !== 'NotAllowedError') {
        console.error('Play error:', e);
      }
      return false;
    } finally {
      promiseRef.current = null;
    }
  };

  // Safe pause function
  const safePause = (videoElement: HTMLVideoElement | null) => {
    if (!videoElement) return;
    try {
      videoElement.pause();
    } catch (e) {
      console.error('Pause error:', e);
    }
  };

  // Preview controls
  const togglePreviewPlay = async () => {
    if (!videoRef.current) return;
    
    if (isPlaying) {
      safePause(videoRef.current);
      setIsPlaying(false);
    } else {
      const played = await safePlay(videoRef.current, playPromiseRef);
      if (played) setIsPlaying(true);
    }
  };

  const togglePreviewMute = () => {
    if (!videoRef.current) return;
    const newMuted = !previewMuted;
    videoRef.current.muted = newMuted;
    setPreviewMuted(newMuted);
  };

  const changePreviewVolume = (val: number) => {
    if (!videoRef.current) return;
    videoRef.current.volume = val;
    setPreviewVolume(val);
    if (val === 0) {
      videoRef.current.muted = true;
      setPreviewMuted(true);
    } else if (previewMuted) {
      videoRef.current.muted = false;
      setPreviewMuted(false);
    }
  };

  // ── Prune stale viewers ─────────────────────────────────────────────
  const pruneStaleViewers = () => {
    const now = Date.now();
    setViewerMap(prev => {
      const next = new Map(prev);
      let changed = false;
      next.forEach((ts, id) => {
        if (now - (ts as number) > VIEWER_TIMEOUT) {
          next.delete(id);
          peerConnections.current.get(id)?.close();
          peerConnections.current.delete(id);
          changed = true;
        }
      });
      if (changed) viewerMapRef.current = next;
      return changed ? next : prev;
    });
  };

  // ── BroadcastChannel ────────────────────────────────────────────────
  useEffect(() => {
    bc.current = new BroadcastChannel('secure_stream_channel');

    bc.current.onmessage = async (event: MessageEvent<StreamMessage>) => {
      const { type, payload } = event.data;
      const viewerId = (payload as any)?.viewerId as string;

      try {
        switch (type) {
          case 'VIEWER_JOIN':
          case 'VIEWER_HEARTBEAT': {
            if (!viewerId) break;
            const now = Date.now();
            setViewerMap(prev => {
              const next = new Map(prev);
              next.set(viewerId, now);
              viewerMapRef.current = next;
              return next;
            });
            if (type === 'VIEWER_JOIN' && streamRef.current) {
              const sid = streamIdRef.current;
              setTimeout(() => initiateWebRTC(viewerId, sid), 400);
            }
            break;
          }

          case 'VIEWER_LEAVE': {
            if (!viewerId) break;
            setViewerMap(prev => {
              const next = new Map(prev);
              next.delete(viewerId);
              viewerMapRef.current = next;
              return next;
            });
            peerConnections.current.get(viewerId)?.close();
            peerConnections.current.delete(viewerId);
            break;
          }

          case 'SIGNAL_ANSWER': {
            const pc = peerConnections.current.get(viewerId);
            if (pc && pc.signalingState !== 'stable' && (payload as any).answer) {
              await pc.setRemoteDescription(new RTCSessionDescription((payload as any).answer)).catch(console.error);
            }
            break;
          }

          case 'SIGNAL_ICE': {
            const pc = peerConnections.current.get(viewerId);
            if (pc && (payload as any).candidate) {
              await pc.addIceCandidate(new RTCIceCandidate((payload as any).candidate)).catch(() => {});
            }
            break;
          }
        }
      } catch (err) {
        console.error('Broadcast message error:', err);
      }
    };

    stalePruneTimer.current = window.setInterval(pruneStaleViewers, 5000);

    return () => {
      stopStream();
      bc.current?.close();
      if (stalePruneTimer.current) clearInterval(stalePruneTimer.current);
    };
  }, []);

  // ── WebRTC ──────────────────────────────────────────────────────────
  const initiateWebRTC = async (targetId: string, currentStreamId: string) => {
    if (!streamRef.current || !currentStreamId) return;
    
    try {
      peerConnections.current.get(targetId)?.close();

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      
      peerConnections.current.set(targetId, pc);
      
      streamRef.current.getTracks().forEach(t => {
        if (streamRef.current) {
          pc.addTrack(t, streamRef.current);
        }
      });

      pc.onicecandidate = e => {
        if (e.candidate && bc.current) {
          bc.current.postMessage({ 
            type: 'SIGNAL_ICE_ADMIN', 
            payload: { viewerId: targetId, candidate: e.candidate.toJSON() } 
          });
        }
      };

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      
      await pc.setLocalDescription(offer);
      
      if (bc.current) {
        bc.current.postMessage({
          type: 'SIGNAL_OFFER',
          payload: {
            viewerId: targetId,
            offer,
            streamId: currentStreamId,
            title: streamTitleRef.current,
            mode: modeRef.current,
            resolution: selectedResolution,
          },
        });
      }
    } catch (e) { 
      console.error('WebRTC Offer error:', e); 
    }
  };

  // ── URL generation ──────────────────────────────────────────────────
  const generateUrl = (): string => {
    const newId = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
    setStreamUrl(buildViewerUrl(newId));
    setStreamId(newId);
    streamIdRef.current = newId;
    return newId;
  };

  // ── Stream setup with selected devices and resolution ───────────────
  const setupStream = async (stream: MediaStream, newMode: StreamMode) => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    
    streamRef.current = stream;

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      await safePlay(videoRef.current, playPromiseRef);
    }

    setMode(newMode);
    modeRef.current = newMode;
    const newId = generateUrl();

    if (bc.current) {
      bc.current.postMessage({
        type: 'STREAM_UPDATE',
        payload: { 
          title: streamTitleRef.current, 
          mode: newMode, 
          streamId: newId,
          resolution: selectedResolution 
        },
      });
    }

    peerConnections.current.forEach((_, id) => {
      peerConnections.current.get(id)?.close();
      initiateWebRTC(id, newId);
    });

    setTip(getRandomTip());
    setIsFileUploading(false);
  };

  // ── Start camera with selected devices and resolution ───────────────
  const startCamera = async () => {
    try {
      setError('');
      
      const constraints: MediaStreamConstraints = {
        video: selectedVideoDevice ? {
          deviceId: { exact: selectedVideoDevice },
          width: { ideal: selectedResolution.width },
          height: { ideal: selectedResolution.height },
        } : {
          width: { ideal: selectedResolution.width },
          height: { ideal: selectedResolution.height },
        },
        audio: selectedAudioDevice ? {
          deviceId: { exact: selectedAudioDevice },
        } : true,
      };

      const s = await navigator.mediaDevices.getUserMedia(constraints);
      await setupStream(s, StreamMode.LIVE);
    } catch (e: any) {
      showError(e, 'Camera');
    }
  };

  // ── Start screen share ──────────────────────────────────────────────
  const startScreen = async () => {
    try {
      setError('');
      
      const s = await navigator.mediaDevices.getDisplayMedia({ 
        video: true, 
        audio: true 
      });
      
      s.getVideoTracks()[0].addEventListener('ended', () => stopStream());
      
      await setupStream(s, StreamMode.SCREEN);
    } catch (e: any) {
      if (e.name !== 'NotAllowedError' && e.name !== 'PermissionDeniedError') {
        showError(e, 'Screen');
      }
    }
  };

  // ── Handle file upload ──────────────────────────────────────────────
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsFileUploading(true);
    setError('');

    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }

      if (fileVideoRef.current) {
        fileVideoRef.current.pause();
        fileVideoRef.current.src = '';
        fileVideoRef.current.load();
      }

      const videoUrl = URL.createObjectURL(file);
      
      if (!fileVideoRef.current) {
        fileVideoRef.current = document.createElement('video');
        fileVideoRef.current.muted = true;
        fileVideoRef.current.loop = true;
        fileVideoRef.current.crossOrigin = 'anonymous';
      }

      fileVideoRef.current.src = videoUrl;

      await new Promise<void>((resolve, reject) => {
        if (!fileVideoRef.current) return reject();
        fileVideoRef.current.onloadedmetadata = () => resolve();
        fileVideoRef.current.onerror = () => reject(new Error('Failed to load video'));
      });

      if (!fileVideoRef.current.videoWidth || !fileVideoRef.current.videoHeight) {
        throw new Error('Invalid video file');
      }

      if ('captureStream' in fileVideoRef.current) {
        // @ts-ignore
        const capturedStream = fileVideoRef.current.captureStream(30);
        
        if (capturedStream && capturedStream.getVideoTracks().length > 0) {
          streamRef.current = capturedStream;
          
          if (videoRef.current) {
            videoRef.current.srcObject = capturedStream;
            videoRef.current.muted = true;
            await safePlay(videoRef.current, playPromiseRef);
          }

          setMode(StreamMode.FILE_UPLOAD);
          modeRef.current = StreamMode.FILE_UPLOAD;
          
          const newId = generateUrl();
          
          if (bc.current) {
            bc.current.postMessage({
              type: 'STREAM_UPDATE',
              payload: { 
                title: streamTitleRef.current, 
                mode: StreamMode.FILE_UPLOAD, 
                streamId: newId,
                resolution: { width: fileVideoRef.current.videoWidth, height: fileVideoRef.current.videoHeight, label: 'File' }
              },
            });
          }

          peerConnections.current.forEach((_, id) => {
            peerConnections.current.get(id)?.close();
            initiateWebRTC(id, newId);
          });

          setTip(getRandomTip());
        } else {
          throw new Error('Could not capture video stream');
        }
      } else {
        throw new Error('Your browser does not support streaming from video files. Try Chrome or Edge.');
      }
    } catch (err: any) {
      console.error('File upload error:', err);
      setError(`File upload failed: ${err.message}`);
      stopStream();
    } finally {
      setIsFileUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // ── Stop stream ─────────────────────────────────────────────────────
  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    if (fileVideoRef.current) {
      fileVideoRef.current.pause();
      fileVideoRef.current.src = '';
      fileVideoRef.current.load();
      fileVideoRef.current = null;
    }
    
    if (videoRef.current) {
      safePause(videoRef.current);
      videoRef.current.srcObject = null;
      videoRef.current.src = '';
      videoRef.current.load();
    }
    
    peerConnections.current.forEach(pc => {
      try { pc.close(); } catch (e) { console.error('Error closing peer connection:', e); }
    });
    peerConnections.current.clear();
    
    setViewerMap(new Map());
    viewerMapRef.current = new Map();
    setMode(StreamMode.IDLE);
    modeRef.current = StreamMode.IDLE;
    setStreamUrl('');
    setStreamId('');
    streamIdRef.current = '';
    setTip('');
    setIsPlaying(true);
    setPreviewMuted(true);
    setPreviewVolume(0);
    
    if (bc.current) {
      bc.current.postMessage({ type: 'STOP_STREAM', payload: {} });
    }
  };

  const showError = (e: any, type: string) => {
    const msgs: Record<string, string> = {
      NotAllowedError: `${type} permission denied. Please grant access to continue.`,
      NotFoundError: `No ${type.toLowerCase()} device found. Please connect a device and try again.`,
      NotReadableError: `${type} is already in use by another application.`,
      OverconstrainedError: `The selected ${type.toLowerCase()} doesn't support the chosen resolution.`,
    };
    setError(msgs[e.name] || `${type}: ${e.message}`);
    setTimeout(() => setError(''), 5000);
  };

  const handleCopy = async () => {
    try { 
      await navigator.clipboard.writeText(streamUrl); 
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { 
      const textarea = document.createElement('textarea');
      textarea.value = streamUrl;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="admin-panel">
      <div className="panel-header">
        <h2>Admin Panel</h2>
        <div className="viewer-count">
          👥 {viewerMap.size} viewer{viewerMap.size === 1 ? '' : 's'}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="stream-config">
        <label>
          Stream Title
          <input
            type="text"
            value={streamTitle}
            onChange={(e) => setStreamTitle(e.target.value)}
            placeholder="Enter stream title"
          />
        </label>

        <div className="resolution-selector">
          <label>Resolution</label>
          <select
            value={selectedResolution.label}
            onChange={(e) => {
              const res = RESOLUTIONS.find(r => r.label === e.target.value);
              if (res) setSelectedResolution(res);
            }}
          >
            {RESOLUTIONS.map(r => (
              <option key={r.label} value={r.label}>{r.label}</option>
            ))}
          </select>
        </div>

        <button className="device-settings-btn" onClick={() => setShowDeviceMenu(!showDeviceMenu)}>
          ⚙️ Devices
        </button>
      </div>

      {showDeviceMenu && (
        <div className="device-menu">
          <label>
            Camera
            <select
              value={selectedVideoDevice}
              onChange={(e) => setSelectedVideoDevice(e.target.value)}
            >
              {videoDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
              ))}
            </select>
          </label>

          <label>
            Microphone
            <select
              value={selectedAudioDevice}
              onChange={(e) => setSelectedAudioDevice(e.target.value)}
            >
              {audioDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="preview-container">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="preview-video"
        />

        <div className="preview-controls">
          <button onClick={togglePreviewPlay}>
            {isPlaying ? '⏸️' : '▶️'}
          </button>
          <button onClick={togglePreviewMute}>
            {previewMuted ? '🔇' : '🔊'}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={previewMuted ? 0 : previewVolume}
            onChange={(e) => changePreviewVolume(parseFloat(e.target.value))}
          />
        </div>
      </div>

      <div className="action-buttons">
        <button
          className="start-camera"
          onClick={startCamera}
          disabled={mode !== StreamMode.IDLE}
        >
          📹 Start Camera
        </button>
        <button
          className="start-screen"
          onClick={startScreen}
          disabled={mode !== StreamMode.IDLE}
        >
          🖥️ Share Screen
        </button>
        <label className="upload-btn">
          📁 Upload File
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={handleFile}
            disabled={mode !== StreamMode.IDLE || isFileUploading}
          />
        </label>
        <button
          className="stop-stream"
          onClick={stopStream}
          disabled={mode === StreamMode.IDLE}
        >
          ⏹️ Stop Stream
        </button>
      </div>

      {mode !== StreamMode.IDLE && (
        <div className="stream-info">
          <div className="stream-url">
            <span>Viewer URL:</span>
            <input type="text" value={streamUrl} readOnly />
            <button onClick={handleCopy}>
              {copied ? '✅ Copied!' : '📋 Copy'}
            </button>
          </div>
          <div className="ai-tip">
            💡 {tip}
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminPanel;
