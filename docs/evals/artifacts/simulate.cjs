// Run from the repository root after npm ci --prefix client.
// node docs/evals/artifacts/simulate.cjs <git-revision> > output.json
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const ts = createRequire(path.resolve('client/package.json'))('typescript');

const requested = process.argv[2];
const profile = process.argv[3] || 'original';
if (!['original', 'sensitivity'].includes(profile)) throw new Error('Unknown fixture profile ' + profile);
const sensitivity = profile === 'sensitivity';
if (!requested) throw new Error('Pass the baseline or candidate git revision');
const revision = execFileSync('git', ['rev-parse', '--verify', requested + '^{commit}'], { encoding: 'utf8' }).trim();
const build = mkdtempSync(path.join(os.tmpdir(), 'samemoon-eval-'));
const sources = {};
function loadControllers() {
  for (const name of ['ClockSync', 'SyncEngine']) {
    const src = execFileSync('git', ['show', revision + ':client/src/services/sync/' + name + '.ts'], { encoding: 'utf8' });
    sources[name] = crypto.createHash('sha256').update(src).digest('hex');
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(path.join(build, name + '.js'), js.outputText);
  }
  return { ...require(path.join(build, 'ClockSync.js')), ...require(path.join(build, 'SyncEngine.js')) };
}

class Scheduler {
  now = 0;
  id = 0;
  events = new Map();
  add(cb, ms, period = 0) {
    const id = ++this.id;
    this.events.set(id, { id, cb, at: this.now + ms, period });
    return id;
  }
  advance(target) {
    while (true) {
      const next = [...this.events.values()].filter(e => e.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.now = next.at;
      if (next.period) next.at += next.period;
      else this.events.delete(next.id);
      next.cb();
    }
    this.now = target;
  }
  clock(offset, ppm) {
    return {
      now: () => 1_000_000 + offset + this.now * (1 + ppm / 1_000_000),
      setTimeout: (cb, ms) => this.add(cb, ms),
      setInterval: (cb, ms) => this.add(cb, ms, ms),
      clearTimeout: id => this.events.delete(id),
      clearInterval: id => this.events.delete(id),
    };
  }
}

class Media {
  constructor(scheduler, ppm) {
    this.scheduler = scheduler;
    this.speed = 1 + ppm / 1_000_000;
  }
  pos = 100;
  last = 0;
  rate = 1;
  paused = true;
  seeks = 0;
  listeners = new Map();
  getTime() { return this.pos + (this.paused ? 0 : (this.scheduler.now - this.last) * this.rate * this.speed / 1000); }
  getRate() { return this.rate; }
  getPaused() { return this.paused; }
  freeze() { this.pos = this.getTime(); this.last = this.scheduler.now; }
  setRate(v) { this.freeze(); this.rate = v; this.emit('ratechange'); }
  seek(v) { this.freeze(); this.pos = v; this.seeks++; this.emit('seeked'); }
  play() { this.freeze(); this.paused = false; this.emit('play'); return Promise.resolve(); }
  pause() { this.freeze(); this.paused = true; this.emit('pause'); }
  on(k, cb) {
    if (!this.listeners.has(k)) this.listeners.set(k, new Set());
    this.listeners.get(k).add(cb);
    return () => this.listeners.get(k).delete(cb);
  }
  emit(k) { for (const cb of this.listeners.get(k) || []) cb(); }
}

// Fixed stress fixtures, not a sampled network distribution. No per-version parameters.
const originalCases = [
  { name: 'nominal-1x', rate: 1, errorMs: -700 },
  { name: 'ahead-1.5x', rate: 1.5, errorMs: 800 },
  { name: 'behind-0.75x', rate: 0.75, errorMs: -650 },
  { name: 'lost-heartbeats', rate: 1, errorMs: -400, gap: [1000, 25000] },
  { name: 'hard-seek', rate: 1, errorMs: -3200 },
  { name: 'inside-deadband', rate: 1, errorMs: 90 },
];
// Specified after the controller commit, before observing this profile's outcomes.
const asymmetricCases = [
  { name: 'asymmetric-ahead-0.5x', rate: 0.5, errorMs: 1200 },
  { name: 'asymmetric-behind-2x', rate: 2, errorMs: -1450 },
  { name: 'asymmetric-long-silence', rate: 1.25, errorMs: -1750, gap: [900, 44000] },
  { name: 'asymmetric-band-edge', rate: 1, errorMs: -340 },
];
const scenarios = sensitivity ? asymmetricCases : originalCases;
const warmup = 20_000;
const horizon = 60_000;
const cadence = 100;
const band = 300;
const jitter = [18, 64, 26, 101, 35, 22, 47, 29];
const directionalJitter = [[180, 440, 205, 510, 170, 330, 215], [14, 25, 9, 28, 42, 11, 17]];
const followerClockOffsetMs = sensitivity ? -920 : 375;
const followerClockPpm = sensitivity ? -65 : 40;
const followerMediaPpm = sensitivity ? -115 : 80;
const round = x => Number(x.toFixed(3));

function run({ ClockSync, SyncEngine }, fixture) {
  const scheduler = new Scheduler();
  const media = [new Media(scheduler, 0), new Media(scheduler, followerMediaPpm)];
  const clocks = [scheduler.clock(0, 0), scheduler.clock(followerClockOffsetMs, followerClockPpm)].map(c => new ClockSync(c));
  const engines = [];
  const count = [0, 0];
  let dropped = 0;
  for (let i = 0; i < 2; i++) {
    const transport = { send(message) {
      const n = count[i]++;
      const t = scheduler.now - warmup;
      if (fixture.gap && t >= fixture.gap[0] && t < fixture.gap[1]) { dropped++; return; }
      const delay = sensitivity
        ? directionalJitter[i][n % directionalJitter[i].length]
        : jitter[(n + i * 3) % jitter.length];
      scheduler.add(() => engines[1-i].handleRemoteMessage(message), delay);
    }};
    engines.push(new SyncEngine({ adapter: media[i], userId: i ? 'b' : 'a', clockSync: clocks[i], transport }));
  }
  engines.forEach(e => e.start());
  scheduler.advance(warmup - 1);
  if (!clocks.every(c => c.isReady)) throw new Error('Clock warmup failed');
  // Playback begins with a specified timeline displacement, without injecting a user seek.
  media.forEach((m, i) => {
    m.last = warmup;
    m.pos = 100 + (i ? fixture.errorMs / 1000 : 0);
    m.rate = fixture.rate;
    m.paused = false;
  });
  const trace = [];
  for (let t = 0; t <= horizon; t += cadence) {
    scheduler.advance(warmup + t);
    trace.push([t, round((media[1].getTime() - media[0].getTime()) * 1000), round(media[1].rate)]);
  }
  const lastOutside = trace.findLastIndex(row => Math.abs(row[1]) > band);
  // Require at least one full 5s heartbeat interval of observations in-band.
  const start = trace[lastOutside + 1]?.[0];
  const settledMs = start !== undefined && horizon - start >= 5000 ? start : null;
  const overshootMs = round(Math.max(0, ...trace.map(row => -Math.sign(fixture.errorMs) * row[1])));
  engines.forEach(e => e.stop());
  return { fixture, settledMs, overshootMs, finalSignedErrorMs: trace.at(-1)[1], followerSeeks: media[1].seeks, dropped, trace };
}

try {
  const controllers = loadControllers();
  const sampleClock = new controllers.ClockSync();
  // Remote processing takes 400ms inside a 20ms exchange: impossible on sane clocks.
  for (let i = 0; i < 3; i++) sampleClock.addSample(100, 500, 900, 120);
  const invalidClock = { ready: sampleClock.isReady, offsetMs: sampleClock.getOffset() };
  const result = {
    revision, sources, node: process.version, typescript: ts.version,
    config: { warmup, horizon, cadence, band, ...(sensitivity ? { profile, directionalJitter } : { jitter }), followerClockOffsetMs, followerClockPpm, followerMediaPpm, traceColumns: ['elapsedMs', 'followerMinusLeaderMs', 'followerPlaybackRate'] },
    invalidClock, cases: scenarios.map(s => run(controllers, s)),
  };
  console.log(JSON.stringify(result, null, 0));
} finally {
  rmSync(build, { recursive: true, force: true });
}
