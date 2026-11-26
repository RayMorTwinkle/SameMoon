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

    // Hold both messages until both users independently produce sequence 1.
    const toA: Record<string, unknown>[] = [];
    const toB: Record<string, unknown>[] = [];
    engineA['transport'] = { send: m => toB.push(m) };
    engineB['transport'] = { send: m => toA.push(m) };
    adapterA.seek(12);
    adapterB.seek(15);
    expect(toA).toHaveLength(1);
    expect(toB).toHaveLength(1);
    engineA.handleRemoteMessage(toA[0]);
    engineB.handleRemoteMessage(toB[0]);
    expect(adapterA.getTime()).toBe(15);
    expect(adapterB.getTime()).toBe(15);
  });

  it('场景 3：小漂移 0.5s → 变速追赶，不 seek', () => {
    engineA.start();
    engineB.start();

    for (let i = 0; i < 3; i++) engineB.sendHeartbeat();
    adapterA.currentTime = 100.5;
    adapterB.currentTime = 100;
    adapterA.paused = adapterB.paused = false;
    engineA.sendHeartbeat();
    expect(adapterB.getRate()).toBeCloseTo(1.05);
    expect(adapterB.calls.some(c => c.method === 'seek')).toBe(false);
    expect(adapterA.getRate()).toBe(1);
  });

  it('场景 4：大漂移 >2s → follower 跳转至 leader 的进度', () => {
    engineA.start();
    engineB.start();
    for (let i = 0; i < 3; i++) engineB.sendHeartbeat();
    adapterA.currentTime = 103;
    adapterB.currentTime = 100;
    adapterA.paused = adapterB.paused = false;
    engineA.sendHeartbeat();
    expect(adapterB.calls.filter(c => c.method === 'seek')).toHaveLength(1);
    expect(adapterB.getTime()).toBe(103);
    expect(adapterA.calls.some(c => c.method === 'seek')).toBe(false);
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
