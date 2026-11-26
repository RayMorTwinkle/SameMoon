import { describe, it, expect } from 'vitest';
import { ClockSync } from '../src/services/sync/ClockSync';
import { SyncEngine } from '../src/services/sync/SyncEngine';
import { FakeClock, FakeAdapter } from './fakes';

function session() {
  const clock = new FakeClock();
  const clockSync = new ClockSync(clock);
  const adapter = new FakeAdapter();
  adapter.paused = false;
  adapter.rate = 1.5;
  const messages: Record<string, unknown>[] = [];
  const engine = new SyncEngine({ adapter, clockSync, userId: 'b', transport: { send: m => messages.push(m) } });
  engine.start();
  return { clock, clockSync, adapter, engine, messages };
}

describe('playback controller', () => {
  it('keeps the selected rate on the wire, restores it when heartbeats stop', () => {
    const { engine, adapter, messages, clock } = session();
    engine.applyDriftCorrection(0.45, false, clock.now());
    expect(adapter.rate).toBeCloseTo(1.575);
    engine.sendHeartbeat();
    engine.sendState();
    expect(messages).toHaveLength(2);
    expect(messages.map(m => m.data)).toEqual([expect.objectContaining({ rate: 1.5 }), expect.objectContaining({ rate: 1.5 })]);
    clock.advance(6_001);
    expect(adapter.rate).toBe(1.5);
    expect(messages.some(m => m.type === 'sync:rate')).toBe(false);
    engine.stop();
  });

  it('keeps a user rate change made during a correction', () => {
    const { engine, adapter, messages, clock } = session();
    engine.applyDriftCorrection(0.6, false, clock.now());
    adapter.setRate(2);
    clock.advance(12_000);
    expect(adapter.rate).toBe(2);
    expect(messages.filter(m => m.type === 'sync:rate')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ rate: 2 }) }),
    ]);
    engine.stop();
  });

  it('starts and stops idempotently and cancels all periodic work', () => {
    const { engine, adapter, messages, clock } = session();
    engine.start();
    clock.advance(15_000);
    expect(messages).toHaveLength(3);
    engine.applyDriftCorrection(1, false, clock.now());
    engine.stop();
    engine.stop();
    expect(adapter.rate).toBe(1.5);
    clock.advance(15_000);
    expect(messages).toHaveLength(3);
  });

  it('ignores an older snapshot and an incomplete state without mutating the player', () => {
    const { engine, adapter, clock } = session();
    const data = { paused: true, rate: 1, sentAt: clock.now(), senderId: 'a' };
    engine.handleRemoteMessage({ type: 'sync:seek', data: { ...data, time: 10, seq: 2 } });
    engine.handleRemoteMessage({ type: 'sync:state', data: { ...data, time: 2, seq: 1 } });
    engine.handleRemoteMessage({ type: 'sync:seek', data: { seq: 3, time: 3 } });
    expect(adapter.getTime()).toBe(10);
    engine.stop();
  });
});

describe('four-timestamp sample window', () => {
  it('rejects impossible intervals and nonfinite input; reset clears the estimate', () => {
    const sync = new ClockSync(new FakeClock());
    for (let n = 0; n < 3; n++) {
      sync.addSample(100, 500, 900, 120);
      sync.addSample(100, NaN, 520, 120);
      sync.addSample(130, 520, 500, 120);
    }
    expect(sync.isReady).toBe(false);
    for (let n = 0; n < 3; n++) sync.addSample(100, 510, 510, 120);
    expect(sync.isReady).toBe(true);
    expect(sync.getOffset()).toBe(400);
    sync.reset();
    expect(sync.getOffset()).toBe(0);
    expect(sync.isReady).toBe(false);
  });
});
