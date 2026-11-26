// Both endpoints must be the local instance under test.
import assert from 'node:assert/strict';
import { once } from 'node:events';
const origin = new URL(process.argv[2]);
const api = new URL(process.argv[3] ?? origin);
for (const url of [origin, api]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
for (const route of ['/', '/room/1234', '/room/1234/play']) {
  const page = await fetch(new URL(route, origin), { signal: AbortSignal.timeout(10000) });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('id="root"'));
  console.log('GET', route, '200 + SPA shell');
}
const health = await fetch(new URL('/health', api), { signal: AbortSignal.timeout(5000) });
assert.equal((await health.json()).status, 'ok');
console.log('GET /health ok');
const ws = new WebSocket(new URL('/ws', origin).href.replace(/^http/, 'ws'));
const next = name => once(ws, name, { signal: AbortSignal.timeout(5000) });
try {
  await next('open');
  for (const [type, data, expected] of [
    ['session:hello', { sessionId: crypto.randomUUID() }, 'connected'],
    ['ping', {}, 'pong'],
    ['room:create', { mode: 'local-sync' }, 'room:created'],
  ]) {
    const result = next('message');
    ws.send(JSON.stringify({ type, data }));
    assert.equal(JSON.parse((await result)[0].data).type, expected);
    console.log(type, '->', expected);
  }
} finally { ws.close(); }
