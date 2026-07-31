/**
 * 文件传输全局状态 — 跨 RoomPage / PlayerPage 共享
 *
 * 传输在 RoomPage 发起，但流式播放在 PlayerPage：DataChannel/MSE 必须跨导航存活，
 * 因此 service（peer）与 controller（MSE）都存这里（与 screenShareStore 同思路）。
 */

import type { FileTransferService } from './FileTransferService';
import type { MseStreamController } from '../playback/MseStreamController';

export type TransferMode = 'complete' | 'stream';

interface FileTransferStoreState {
  service: FileTransferService | null;
  controller: MseStreamController | null; // 流式模式（接收方）
  mode: TransferMode | null;
  fileName: string | null;
  fileSize: number | null;
  fileType: string | null;
}

const state: FileTransferStoreState = {
  service: null,
  controller: null,
  mode: null,
  fileName: null,
  fileSize: null,
  fileType: null,
};

export const fileTransferStore = {
  get state() { return state; },

  setService(service: FileTransferService, mode: TransferMode, meta: { name: string; size: number; type: string }) {
    state.service = service;
    state.mode = mode;
    state.fileName = meta.name;
    state.fileSize = meta.size;
    state.fileType = meta.type;
  },

  setController(controller: MseStreamController) {
    state.controller = controller;
  },

  getController(): MseStreamController | null {
    return state.controller;
  },

  getPeer() {
    return state.service?.getPeer() ?? null;
  },

  reset() {
    try { state.service?.stop(); } catch { /* ignore */ }
    try { state.controller?.destroy(); } catch { /* ignore */ }
    state.service = null;
    state.controller = null;
    state.mode = null;
    state.fileName = null;
    state.fileSize = null;
    state.fileType = null;
  },
};
