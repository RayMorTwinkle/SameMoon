/**
 * MseStreamController — 流式播放核心（模式 B2）
 *
 * 把 DataChannel 收到的原始文件字节流实时喂给 MediaSource：
 * - MP4/MOV：用 mp4box.js 边解析边 remux 成 fragmented MP4 分段，逐段 appendBuffer
 *   （纯改容器不重编码，画质无损；moov 在文件头的 faststart MP4 可真正边下边播，
 *    moov 在尾部的普通 MP4 会退化成"下完再播"，但仍可用）
 * - WebM：MSE 原生支持，直接 append 原始字节
 * - 其它（MKV 等）：MSE 不支持 → canStream() 返回 false，UI 应引导用完整传输模式
 *
 * 与页面解耦：controller 存活于 fileTransferStore，跨 RoomPage→PlayerPage 导航不销毁，
 * 后台持续接收 + append，PlayerPage 只把 objectUrl 交给 <video>。
 */

// mp4box 的 ESM 构建只有具名导出（createFile/ISOFile/...），无 default 导出；
// dev 模式(esbuild)会伪造 default，生产打包器(rolldown)不会 → 必须用具名导入
import { createFile } from 'mp4box';
import { debugStore } from '../debugStore';

/** 带 mp4box 队列标记的 SourceBuffer */
type QueuedSourceBuffer = SourceBuffer & { __queue: ArrayBuffer[] };

export class MseStreamController {
  readonly mediaSource: MediaSource;
  readonly objectUrl: string;

  private readonly useMp4box: boolean;
  private mp4box: ReturnType<typeof createFile> | null = null;
  private mp4info: { tracks: Array<{ id: number; type: string; codec: string }> } | null = null;
  private sourceOpen = false;
  private setupDone = false;
  private fileStart = 0;

  // WebM 直连路径
  private webmSb: QueuedSourceBuffer | null = null;
  private webmMime = '';

  private ended = false;
  private pendingEnd = false;
  private appendCount = 0;

  /** 该文件能否流式播放（MSE 容器限制） */
  static canStream(name: string, type: string): boolean {
    return /\.(mp4|m4v|mov|webm)$/i.test(name) || /(mp4|webm)/i.test(type);
  }

  constructor(fileName: string, mimeType: string) {
    const isWebm = /webm/i.test(mimeType) || /\.webm$/i.test(fileName);
    this.useMp4box = !isWebm;
    debugStore.log('mse', 'controller-create', { fileName, mimeType, useMp4box: this.useMp4box });

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.mediaSource.addEventListener('sourceopen', () => {
      this.sourceOpen = true;
      debugStore.log('mse', 'sourceopen', { useMp4box: this.useMp4box });
      if (this.useMp4box) this.trySetupMp4();
      else this.setupWebm();
    }, { once: true });

    if (this.useMp4box) {
      this.mp4box = createFile();
      this.mp4box.onError = (e: unknown) => debugStore.logError('mse', 'mp4box-error', String(e));
      this.mp4box.onReady = (info: typeof this.mp4info) => { this.mp4info = info; this.trySetupMp4(); };
      this.mp4box.onSegment = (_id: number, sb: QueuedSourceBuffer, buffer: ArrayBuffer) => {
        sb.__queue.push(buffer);
        this.flushSb(sb);
      };
    }
  }

  /** 接收到一块原始文件字节 */
  append(chunk: ArrayBuffer): void {
    this.appendCount += 1;
    if (this.appendCount === 1) debugStore.log('mse', 'first-chunk', { bytes: chunk.byteLength });
    if (this.useMp4box) {
      if (!this.mp4box) return;
      // mp4box 需要每块标注在原文件中的字节偏移
      (chunk as ArrayBuffer & { fileStart: number }).fileStart = this.fileStart;
      this.fileStart += chunk.byteLength;
      this.mp4box.appendBuffer(chunk);
      // 注意：flush() 只在 complete() 时调用一次；每块都 flush 会打断分段管线
    } else {
      this.webmSb?.__queue.push(chunk) ?? this.pendingWebm.push(chunk);
      if (this.webmSb) this.flushSb(this.webmSb);
    }
  }

  /** 全部字节接收完毕 */
  complete(): void {
    this.pendingEnd = true;
    if (this.useMp4box && this.mp4box) {
      this.mp4box.flush?.();
    }
    this.tryEndOfStream();
  }

  destroy(): void {
    try {
      if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch { /* ignore */ }
    URL.revokeObjectURL(this.objectUrl);
    this.mp4box = null;
  }

  // ─── 内部 ────────────────────────────────────────────

  // WebM：sourceopen 前到达的块暂存
  private pendingWebm: ArrayBuffer[] = [];

  private setupWebm(): void {
    // 优先用不带 codecs 的 'video/webm'：让浏览器从容器自嗅探实际编码，
    // 避免硬猜 codec 串与真实内容不符导致解码失败（webm 流式连不上的常见根因）。
    // 若浏览器拒绝无 codecs 的类型，再依次回退到常见组合。
    const candidates = [
      'video/webm',
      'video/webm; codecs="vp9,opus"',
      'video/webm; codecs="vp8,vorbis"',
      'video/webm; codecs="vp9,vorbis"',
      'video/webm; codecs="vp8,opus"',
      'video/webm; codecs="av01.0.05M.08,opus"',
    ];
    let sb: QueuedSourceBuffer | null = null;
    for (const m of candidates) {
      if (!MediaSource.isTypeSupported(m)) continue;
      try {
        sb = this.mediaSource.addSourceBuffer(m) as QueuedSourceBuffer;
        this.webmMime = m;
        break;
      } catch (e) {
        debugStore.log('mse', 'webm-addsb-skip', { mime: m, err: String(e) });
      }
    }
    if (!sb) {
      debugStore.logError('mse', 'webm-unsupported', '浏览器无法为该 WebM 创建 SourceBuffer');
      return;
    }
    debugStore.log('mse', 'webm-setup', { mime: this.webmMime });
    sb.__queue = this.pendingWebm;
    this.pendingWebm = [];
    sb.addEventListener('updateend', () => this.flushSb(sb!));
    sb.addEventListener('error', () => debugStore.logError('mse', 'webm-sb-error', 'SourceBuffer error 事件（编码可能不匹配）'));
    this.webmSb = sb;
    this.flushSb(sb);
  }

  private trySetupMp4(): void {
    if (this.setupDone || !this.sourceOpen || !this.mp4info || !this.mp4box) return;
    this.setupDone = true;

    for (const track of this.mp4info.tracks) {
      const kind = track.type === 'audio' ? 'audio' : 'video';
      const mime = `${kind}/mp4; codecs="${track.codec}"`;
      if (!MediaSource.isTypeSupported(mime)) {
        debugStore.logError('mse', 'codec-unsupported', mime);
        continue;
      }
      const sb = this.mediaSource.addSourceBuffer(mime) as QueuedSourceBuffer;
      sb.__queue = [];
      sb.addEventListener('updateend', () => this.flushSb(sb));
      sb.addEventListener('error', () => debugStore.logError('mse', 'mp4-sb-error', mime));
      this.mp4box.setSegmentOptions(track.id, sb, { nbSamples: 200 });
    }

    const initSegs = this.mp4box.initializeSegmentation();
    for (const seg of initSegs) {
      const sb = seg.user as QueuedSourceBuffer;
      sb.__queue.push(seg.buffer);
      this.flushSb(sb);
    }
    this.mp4box.start();
    debugStore.log('mse', 'mp4-setup', `${this.mp4info.tracks.length} tracks`);
  }

  private flushSb(sb: QueuedSourceBuffer): void {
    if (this.mediaSource.readyState !== 'open') return;
    if (sb.updating || sb.__queue.length === 0) {
      this.tryEndOfStream();
      return;
    }
    const buf = sb.__queue.shift()!;
    try {
      sb.appendBuffer(buf);
    } catch (e) {
      debugStore.logError('mse', 'append-failed', String(e));
    }
  }

  private tryEndOfStream(): void {
    if (this.ended || !this.pendingEnd) return;
    if (this.mediaSource.readyState !== 'open') return;
    const buffers = Array.from(this.mediaSource.sourceBuffers);
    const allIdle = buffers.every(sb => !sb.updating && (sb as QueuedSourceBuffer).__queue?.length === 0);
    if (!allIdle || buffers.length === 0) return;
    try {
      this.mediaSource.endOfStream();
      this.ended = true;
    } catch { /* ignore */ }
  }
}
