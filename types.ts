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
  groupId?: string;
  kind?: string;
}

export interface AudioDevice {
  deviceId: string;
  label: string;
  groupId?: string;
  kind?: string;
}

export interface Resolution {
  width: number;
  height: number;
  label: string;
  frameRate?: number;
}

export interface StreamInfo {
  id: string;
  title: string;
  mode: StreamMode;
  resolution: Resolution;
  hasAudio: boolean;
  startedAt?: string;
  viewerCount?: number;
  thumbnailUrl?: string;
}