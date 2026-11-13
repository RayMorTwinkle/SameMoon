import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { buildApp } from '../dist/app.js';

test('malformed room messages return an error and server stays healthy', async () => {
  const app=await buildApp(); await app.listen({host:'127.0.0.1',port:0});
  const port=app.server.address().port;
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await once(ws,'open');
    let response=once(ws,'message');
    ws.send(JSON.stringify({type:'session:hello',data:{sessionId:'regression-only'}}));
    await response;
    for(const data of [undefined,null,{},17,{roomCode:[]}]) {
      response=once(ws,'message'); ws.send(JSON.stringify({type:'room:join',data}));
      const [raw]=await response;
      assert.equal(JSON.parse(raw).data.code,'INVALID_ROOM');
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200);
  } finally {ws.terminate();await app.close();}
});
