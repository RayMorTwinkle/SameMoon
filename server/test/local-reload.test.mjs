import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { buildApp } from '../dist/app.js';

test('reloading a matched local room asks for the file and allows it to match again', { timeout: 8000 }, async () => {
  const app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = 'ws://127.0.0.1:' + app.server.address().port + '/ws';
  const sockets = [];
  const send = (socket, type, data) => socket.send(JSON.stringify({ type, data }));
  const receive = async socket => JSON.parse((await once(socket, 'message', {
    signal: AbortSignal.timeout(2000),
  }))[0].toString());
  async function connect(id) {
    const socket = new WebSocket(url);
    sockets.push(socket);
    await once(socket, 'open');
    const response = receive(socket);
    send(socket, 'session:hello', { sessionId: id });
    return [socket, await response];
  }
  try {
    const [host] = await connect('local-host');
    const created = receive(host);
    send(host, 'room:create', { mode: 'local-sync' });
    const roomCode = (await created).data.roomCode;
    const [guest] = await connect('local-guest');
    const joined = receive(guest);
    send(guest, 'room:join', { roomCode });
    assert.equal((await joined).type, 'room:joined');
    const file = { name: 'short.mp4', size: 7 };
    const matched = receive(guest);
    send(host, 'file:info', file);
    send(guest, 'file:info', file);
    assert.equal((await matched).data.matched, true);

    const left = receive(host);
    guest.close();
    assert.equal((await left).type, 'room:left');
    const [restoredGuest, restored] = await connect('local-guest');
    assert.equal(restored.type, 'session:restored');
    assert.equal(restored.data.roomState, 'selecting');
    assert.equal(restored.data.fileName, file.name);
    const rematched = receive(restoredGuest);
    send(restoredGuest, 'file:info', file);
    assert.equal((await rematched).data.matched, true);
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
  }
});
