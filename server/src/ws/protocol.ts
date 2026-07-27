/** WebSocket 消息协议类型定义 */

export type RoomMode = 'local-sync' | 'file-transfer' | 'screen-share';

export interface WsMessage {
  type: string;
  room?: string;
  from?: string;
  data?: Record<string, unknown>;
}

// 会话恢复（TECH-SPEC §3）
export interface SessionHelloMsg extends WsMessage {
  type: 'session:hello';
  data: { sessionId: string };
}

export interface SessionRestoredMsg extends WsMessage {
  type: 'session:restored';
  data: {
    sessionId: string;
    roomCode: string;
    role: 'host' | 'guest';
    roomState: string;
    peerOnline: boolean;
    mode: RoomMode;
    fileName?: string;
    fileSize?: number;
  };
}

// 房间相关（Stage 2: 新增 mode）
export interface RoomCreateMsg extends WsMessage {
  type: 'room:create';
  data: { mode?: RoomMode };
}

export interface RoomCreatedMsg extends WsMessage {
  type: 'room:created';
  data: { roomCode: string; role: 'host'; mode: RoomMode; peerCount: number };
}

export interface RoomJoinMsg extends WsMessage {
  type: 'room:join';
  data: { roomCode: string };
}

export interface RoomJoinedMsg extends WsMessage {
  type: 'room:joined';
  data: { userId: string; role: 'host' | 'guest'; mode: RoomMode; peerCount: number };
}

export interface RoomLeftMsg extends WsMessage {
  type: 'room:left';
  data: { userId: string };
}

// 文件验证（local-sync 模式）
export interface FileInfoMsg extends WsMessage {
  type: 'file:info';
  data: { name: string; size: number };
}

export interface FileMatchMsg extends WsMessage {
  type: 'file:match';
  data: { matched: boolean; diff?: string };
}

// Stage 2: 文件传输协调
export interface FileOfferMsg extends WsMessage {
  type: 'file:offer';
  data: { name: string; size: number; type: string };
}

export interface FileAcceptMsg extends WsMessage {
  type: 'file:accept';
  data: Record<string, never>;
}

export interface FileProgressMsg extends WsMessage {
  type: 'file:progress';
  data: { transferred: number; total: number };
}

export interface FileCompleteMsg extends WsMessage {
  type: 'file:complete';
  data: Record<string, never>;
}

export interface FileCancelledMsg extends WsMessage {
  type: 'file:cancelled';
  data: { reason?: string };
}

// Stage 2: 屏幕分享协调
export interface ScreenRequestMsg extends WsMessage {
  type: 'screen:request';
  data: Record<string, never>;
}

export interface ScreenGrantMsg extends WsMessage {
  type: 'screen:grant';
  data: Record<string, never>;
}

export interface ScreenBusyMsg extends WsMessage {
  type: 'screen:busy';
  data: { sharer: string };
}

export interface ScreenStopMsg extends WsMessage {
  type: 'screen:stop';
  data: Record<string, never>;
}

// Stage 2: WebRTC 信令 (S→C→S 转发)
export interface RtcOfferMsg extends WsMessage {
  type: 'rtc:offer';
  data: { sdp: string };
}

export interface RtcAnswerMsg extends WsMessage {
  type: 'rtc:answer';
  data: { sdp: string };
}

export interface RtcIceMsg extends WsMessage {
  type: 'rtc:ice';
  data: { candidate: string; sdpMid?: string; sdpMLineIndex?: number };
}

// 同步播放
export interface SyncPlayMsg extends WsMessage {
  type: 'sync:play';
  data: { time: number; timestamp: number };
}

export interface SyncPauseMsg extends WsMessage {
  type: 'sync:pause';
  data: { time: number; timestamp: number };
}

export interface SyncSeekMsg extends WsMessage {
  type: 'sync:seek';
  data: { time: number; timestamp: number };
}

export interface SyncRateMsg extends WsMessage {
  type: 'sync:rate';
  data: { rate: number; timestamp: number };
}

export interface SyncHeartbeatMsg extends WsMessage {
  type: 'sync:heartbeat';
  data: { clientTime: number };
}

// 聊天
export interface ChatMessageMsg extends WsMessage {
  type: 'chat:message';
  data: { text: string };
}

// 错误
export interface ErrorMsg extends WsMessage {
  type: 'error';
  data: { code: string; message: string };
}
