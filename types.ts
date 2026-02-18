export enum StreamMode {
  IDLE = 'IDLE',
  LIVE = 'LIVE',
  SCREEN = 'SCREEN',
  FILE_UPLOAD = 'FILE_UPLOAD'
}

export type StreamMessageType =
  | 'STREAM_UPDATE'
  | 'VIEWER_JOIN'
  | 'VIEWER_HEARTBEAT'  
  | 'VIEWER_LEAVE'
  | 'STOP_STREAM'
  | 'SIGNAL_OFFER'
  | 'SIGNAL_ANSWER'
  | 'SIGNAL_ICE'
  | 'SIGNAL_ICE_ADMIN';

export interface StreamMessage<T = unknown> {
  type: StreamMessageType;
  payload: T;
}

export interface VideoDevice {
  deviceId: string;
  label: string;
  /** Optional group identifier for multi-camera setups */
  groupId?: string;
  /** Optional kind hint, e.g. "videoinput" */
  kind?: string;
}

export interface AudioDevice {
  deviceId: string;
  label: string;
  /** Optional group identifier */
  groupId?: string;
  /** Optional kind hint, e.g. "audioinput" */
  kind?: string;
}

export interface Resolution {
  width: number;
  height: number;
  label: string;
  /** Optional frame-rate hint */
  frameRate?: number;
}

export interface StreamInfo {
  id: string;
  title: string;
  mode: StreamMode;
  resolution: Resolution;
  hasAudio: boolean;
  /** Optional start timestamp (ISO string) */
  startedAt?: string;
  /** Optional viewer count */
  viewerCount?: number;
  /** Optional thumbnail URL */
  thumbnailUrl?: string;
}