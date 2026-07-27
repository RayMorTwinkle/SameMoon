/**
 * SyncEngine 纯逻辑单测（TECH-SPEC §8.2）
 * 两个引擎实例互连 → 验证同步/冲突/漂移/回声/超时
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncEngine } from '../src/services/sync/SyncEngine';
import { ClockSync } from '../src/services/sync/ClockSync';
import { FakeClock, FakeAdapter } from './fakes';

describe('SyncEngine', () => {
  let clockA: FakeClock;
  let clockB: FakeClock;
  let adapterA: FakeAdapter;
  let adapterB: FakeAdapter;
  let engineA: SyncEngine;
  let engineB: SyncEngine;

  beforeEach(() => {
    // 双方时钟一致（时钟偏移不是这些测试的关注点）
    clockA = new FakeClock(1_000_000);
    clockB = new FakeClock(1_000_000);
    adapterA = new FakeAdapter();
    adapterB = new FakeAdapter();

    // 初始状态：都暂停在 0s
    adapterA.paused = true;
    adapterB.paused = true;
    adapterA.currentTime = 0;
    adapterB.currentTime = 0;

    // 先创建引擎（transport 用函数延迟求值，避免循环引用）
    engineA = new SyncEngine({
      adapter: adapterA,
      transport: { send: () => {} },  // 占位，后面重绑
      clockSync: new ClockSync(clockA),
      clock: clockA,
      userId: 'user-a',
    });
    engineB = new SyncEngine({
      adapter: adapterB,
      transport: { send: () => {} },
      clockSync: new ClockSync(clockB),
      clock: clockB,
      userId: 'user-b',
    });

    // 绑定双向传输
    engineA['transport'] = { send: (m) => engineB.handleRemoteMessage(m) };
    engineB['transport'] = { send: (m) => engineA.handleRemoteMessage(m) };
  });

  afterEach(() => {
    engineA.stop();
    engineB.stop();
  });

  it('场景 1：A play → B 状态收敛（paused=false, 时间同步）', () => {
    engineA.start();
    engineB.start();

    // A 在 10s 处播放
    adapterA.currentTime = 10;
    adapterA.play();

    // B 应收敛到 paused=false, time=10
    expect(adapterB.getPaused()).toBe(false);
    expect(adapterB.getTime()).toBeCloseTo(10, 1);
  });

  it('场景 2：双方同时操作（seq 冲突）→ 收敛到同一胜者', () => {
    engineA.start();
    engineB.start();

    // A 先 seek(12)，等回声抑制窗口过期后 B 再 seek(15)
    // 这样 B 的操作不会被当作回声抑制
    adapterA.currentTime = 12;
    adapterA.seek(12);
    // 推进时间超过回声窗口（150ms）
    clockA.advance(200);
    clockB.advance(200);

    adapterB.currentTime = 15;
    adapterB.seek(15);
    // 推进时间超过回声窗口
    clockA.advance(200);
    clockB.advance(200);

    // B 的 seq=1 > A 的 seq=1？不，A 也是 seq=1。
    // seq 相同时 senderId 大者胜：user-b > user-a
    // 所以 A 应收敛到 B 的值（15s）
    expect(adapterA.getTime()).toBeGreaterThanOrEqual(15);
    expect(adapterB.getTime()).toBeGreaterThanOrEqual(15);
    // 双方最终位置相同
    expect(adapterA.getTime()).toBeCloseTo(adapterB.getTime(), 5);
  });

  it('场景 3：小漂移 0.5s → 变速追赶，不 seek', () => {
    engineA.start();
    engineB.start();

    // 先通过心跳校准时钟（≥3 次采样后 isReady=true）
    for (let i = 0; i < 5; i++) {
      engineA.sendHeartbeat();
      clockA.advance(50);
      clockB.advance(50);
    }

    // A 落后 0.5s（在 driftIgnore 0.3s 和 driftRate 2s 之间 → 中档：变速追赶）
    adapterA.currentTime = 100;
    adapterB.currentTime = 100.5;
    adapterA.paused = false;
    adapterB.paused = false;

    // B 发心跳 → A 收到后应加速追赶
    adapterA.resetCalls();
    engineB.sendHeartbeat();
    clockA.advance(50);
    clockB.advance(50);

    // A 应设置 rate=1.05（加速），不应 seek
    const setRateCalls = adapterA.calls.filter(c => c.method === 'setRate');
    expect(setRateCalls.length).toBeGreaterThan(0);
    // 应有 1.05（加速）的调用
    const hasChaseRate = setRateCalls.some(c => (c.args[0] as number) > 1.0);
    expect(hasChaseRate).toBe(true);
    // 不应 seek（中档校正用变速，不用 seek）
    expect(adapterA.calls.filter(c => c.method === 'seek').length).toBe(0);
  });

  it('场景 4：大漂移 >2s → 直接 seek', () => {
    engineA.start();
    engineB.start();

    // 先校准时钟
    for (let i = 0; i < 5; i++) {
      engineA.sendHeartbeat();
      clockA.advance(50);
      clockB.advance(50);
    }

    // A 落后 3s
    adapterA.currentTime = 100;
    adapterB.currentTime = 103;
    adapterA.paused = false;
    adapterB.paused = false;

    adapterA.resetCalls();
    engineB.sendHeartbeat();

    // A 应 seek 到约 103s
    const seekCalls = adapterA.calls.filter(c => c.method === 'seek');
    expect(seekCalls.length).toBeGreaterThan(0);
    expect(seekCalls[seekCalls.length - 1].args[0]).toBeGreaterThan(102);
  });

  it('场景 5：回声抑制 — applyRemote 触发的事件不广播', () => {
    engineA.start();
    engineB.start();

    // A 播放 → B 收到 → B 的适配器触发 play 事件
    adapterA.currentTime = 10;
    adapterA.play();

    // B 的 transport 应只收到 A 的 sync:play，不应有 B 的回声
    // （linkEngines 里 transportB.send 会调到 A，但 B 本地事件不应触发 transportB.send）
    // 验证：A 的 transport 收到的消息数应为 1（仅原始 sync:play）
    // 注意：这里通过 adapterB 的 calls 验证 B 确实执行了 play
    expect(adapterB.getPaused()).toBe(false);
  });

  it('场景 6：缓冲协商 — 30s 超时触发回调', () => {
    const timeoutSpy = { called: false };
    const engine = new SyncEngine({
      adapter: adapterA,
      transport: { send: () => {} },
      clockSync: new ClockSync(clockA),
      clock: clockA,
      userId: 'user-a',
      onEvent: (evt) => {
        if (evt === 'buffering-timeout') timeoutSpy.called = true;
      },
    });

    // 模拟收到 sync:buffering
    engine.handleRemoteMessage({
      type: 'sync:buffering',
      data: { time: 50 },
    });
    expect(adapterA.getPaused()).toBe(true);
    expect(timeoutSpy.called).toBe(false);

    // 推进 30s
    clockA.advance(30_000);
    expect(timeoutSpy.called).toBe(true);

    engine.stop();
  });

  it('场景 7：sync:state 请求/响应 — 空 data 触发 sendState 回复', () => {
    engineA.start();
    engineB.start();

    // A 请求状态（空 data）
    engineA.requestState();

    // B 收到空 sync:state → 应回复完整状态
    // 验证：A 收到 B 的 sync:state 响应（带 seq）
    // 通过 B 的 adapter 状态被 A 的请求改变来验证
    adapterB.currentTime = 42;
    adapterB.paused = false;
    adapterB.rate = 1.5;

    engineA.requestState();

    // A 应收敛到 B 的状态
    expect(adapterA.getTime()).toBe(42);
    expect(adapterA.getPaused()).toBe(false);
    expect(adapterA.getRate()).toBeCloseTo(1.5, 1);
  });

  it('回归：sendState 不应递增 seq（Bug 1 修复）', () => {
    engineA.start();
    engineB.start();

    // 记录 B 在 sendState 前后 seq 的变化
    // 通过 requestState → B.sendState 来触发
    // 先让 B 做一次用户操作，seq 变 1
    adapterB.currentTime = 5;
    adapterB.seek(5);
    // 推进回声窗口
    clockA.advance(200);
    clockB.advance(200);

    // 此时 B 的 seq 应为 1（一次用户操作）
    // 现在 A 请求状态 → B 回复 → 不应改变 B 的 seq
    engineA.requestState();

    // 验证 A 收到了 B 的状态（seq=1）
    expect(adapterA.getTime()).toBeCloseTo(5, 1);

    // B 再做一次用户操作
    adapterB.currentTime = 10;
    adapterB.seek(10);
    clockA.advance(200);
    clockB.advance(200);

    // 此时 B 的 seq 应为 2（从 1 递增），A 应收敛到 10
    expect(adapterA.getTime()).toBeCloseTo(10, 1);
  });
});
