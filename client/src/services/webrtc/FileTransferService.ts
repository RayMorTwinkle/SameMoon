/**
 * FileTransferService — WebRTC DataChannel 点对点文件传输（模式 A/B2 共用传输层）
 *
 * 复用屏幕分享同一套 simple-peer + rtc:signal 信令（含未建连时的信令缓冲队列）。
 * 只负责搬字节，不关心上层是"完整下载"还是"流式播放"：
 *   - onChunk 有回调 → 流式：每块直接交给上层（喂 MSE），不在内存累积
 *   - onChunk 无回调 → 完整：累积所有块，收齐后拼成 File
 * 进度/完成状态走 WS（file:progress/complete），保证 UI 可靠更新（见 PLAN §5.3）。
 */

import Peer from 'simple-peer';
import { debugStore } from '../debugStore';

export type TransferState = 'idle' | 'connecting' | 'transferring' | 'done' | 'error';

const CHUNK_SIZE = 64 * 1024;        // 64KB：所有浏览器安全支持
const HIGH_WATER = 1 * 1024 * 1024;  // bufferedAmount 高水位，超过暂停发送
const LOW_WATER = 256 * 1024;        // 低水位，回落到此恢复发送

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

interface SenderCallbacks {
  onProgress?: (sent: number, total: number) => void;
  onState?: (s: TransferState) => void;
  onDone?: () => void;
}

interface ReceiverCallbacks {
  onProgress?: (received: number, total: number) => void;
  onState?: (s: TransferState) => void;
  /** 流式模式：每块直接交给上层（喂 MSE）。传了此回调则不在内存累积 */
  onChunk?: (chunk: ArrayBuffer) => void;
  /** 收齐后回调；完整模式给出 File，流式模式为 null */
  onComplete?: (file: File | null) => void;
}

async function getRtcConfig(): Promise<RTCConfiguration> {
  try {
    const resp = await fetch('/api/ice-servers');
    const data = await resp.json();
    return { iceServers: (data.iceServers as RTCIceServer[]) ?? [], iceTransportPolicy: 'all' };
  } catch {
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  }
}

export class FileTransferService {
  private peer: Peer.Instance | null = null;
  private pendingSignals: unknown[] = [];
  private cancelled = false;

  /** 统一信令入口：peer 未建好时缓冲，建好后排空（与 ScreenShareService 同款，防 trickle ICE 竞态） */
  signal(data: unknown): void {
    if (this.peer && !(this.peer as unknown as { destroyed?: boolean }).destroyed) {
      this.peer.signal(data as Peer.SignalData);
    } else if (!this.peer) {
      this.pendingSignals.push(data);
    }
  }

  private flushPending(): void {
    if (!this.peer) return;
    for (const s of this.pendingSignals) this.peer.signal(s as Peer.SignalData);
    this.pendingSignals = [];
  }

  getPeer(): Peer.Instance | null {
    return this.peer;
  }

  // ─── 发送方（房主） ──────────────────────────────────

  async startSending(file: File, sendSignal: (d: unknown) => void, cb: SenderCallbacks): Promise<void> {
    cb.onState?.('connecting');
    const config = await getRtcConfig();
    this.peer = new Peer({ initiator: true, config, channelConfig: { ordered: true } });
    this.peer.on('signal', d => sendSignal(d));
    this.peer.on('error', e => {
      debugStore.logError('ft', 'sender-error', e.message);
      cb.onState?.('error');
    });
    this.peer.on('connect', () => { void this.pump(file, cb); });
    this.flushPending();
  }

  private async pump(file: File, cb: SenderCallbacks): Promise<void> {
    cb.onState?.('transferring');
    const channel = (this.peer as unknown as { _channel: RTCDataChannel })._channel;
    channel.bufferedAmountLowThreshold = LOW_WATER;

    let offset = 0;
    while (offset < file.size && !this.cancelled) {
      if (channel.bufferedAmount > HIGH_WATER) {
        // 流控：等缓冲回落到低水位再继续（防止内存暴涨/发送失败）
        await new Promise<void>(resolve => {
          const onLow = () => { channel.removeEventListener('bufferedamountlow', onLow); resolve(); };
          channel.addEventListener('bufferedamountlow', onLow);
        });
        continue;
      }
      const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      try {
        this.peer!.send(new Uint8Array(buf));
      } catch (e) {
        debugStore.logError('ft', 'send-failed', String(e));
        cb.onState?.('error');
        return;
      }
      offset += buf.byteLength;
      cb.onProgress?.(offset, file.size);
    }
    if (!this.cancelled) {
      cb.onState?.('done');
      cb.onDone?.();
    }
  }

  // ─── 接收方（对方） ──────────────────────────────────

  async startReceiving(
    meta: FileMeta,
    sendSignal: (d: unknown) => void,
    cb: ReceiverCallbacks,
    existingSignal?: unknown,
  ): Promise<void> {
    cb.onState?.('connecting');
    const config = await getRtcConfig();
    this.peer = new Peer({ initiator: false, config });
    this.peer.on('signal', d => sendSignal(d));
    this.peer.on('error', e => {
      debugStore.logError('ft', 'receiver-error', e.message);
      cb.onState?.('error');
    });
    this.peer.on('connect', () => cb.onState?.('transferring'));

    const streaming = !!cb.onChunk;
    const chunks: ArrayBuffer[] = [];
    let received = 0;
    let completed = false;

    this.peer.on('data', (d: Uint8Array) => {
      // new Uint8Array(view) 按视图逻辑长度拷贝出独立 ArrayBuffer：
      // 1) 规避 TS5.7+ 把 view.buffer 收窄成 ArrayBuffer|SharedArrayBuffer 的类型错误
      // 2) simple-peer 可能复用底层 buffer，拷贝可避免累积（chunks.push）时数据被覆盖
      const buf: ArrayBuffer = new Uint8Array(d).buffer;
      received += buf.byteLength;
      if (streaming) cb.onChunk!(buf);
      else chunks.push(buf);
      cb.onProgress?.(received, meta.size);

      if (!completed && received >= meta.size) {
        completed = true;
        cb.onState?.('done');
        const file = streaming ? null : new File(chunks, meta.name, { type: meta.type });
        cb.onComplete?.(file);
      }
    });

    if (existingSignal) this.peer.signal(existingSignal as Peer.SignalData);
    this.flushPending();
  }

  stop(): void {
    this.cancelled = true;
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.peer = null;
    this.pendingSignals = [];
  }
}
