/** WebSocket 消息协议类型定义 */

export interface WsMessage {
  type: string;
  room?: string;
  from?: string;
  data?: Record<string, unknown>;
}

// 房间相关
export interface RoomCreateMsg extends WsMessage {
  type: 'room:create';
  data: { fileName: string; fileSize: number };
}

export interface RoomJoinMsg extends WsMessage {
  type: 'room:join';
  data: { roomCode: string };
}

export interface RoomJoinedMsg extends WsMessage {
  type: 'room:joined';
  data: { userId: string; role: 'host' | 'guest' };
}

export interface RoomLeftMsg extends WsMessage {
  type: 'room:left';
  data: { userId: string };
}

// 文件验证
export interface FileInfoMsg extends WsMessage {
  type: 'file:info';
  data: { name: string; size: number };
}

export interface FileMatchMsg extends WsMessage {
  type: 'file:match';
  data: { matched: boolean; diff?: string };
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
