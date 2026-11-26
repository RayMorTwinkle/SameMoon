// node room-recovery.mjs /absolute/path/to/source-tree
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const source = resolve(process.argv[2], 'server/src/room/RoomManager.ts');
const { RoomManager } = await import(pathToFileURL(source));
const manager = new RoomManager();
const socket = () => ({ readyState: 1, send() {} });
const room = manager.createRoom('viewer-a', socket());
manager.joinRoom(room.code, 'viewer-b', socket());
const a = room.users.get('viewer-a');
const b = room.users.get('viewer-b');
const movie = { name: 'example.mp4', size: 123456 };
const checks = [];
function record(scenario, expected) {
  checks.push({ scenario, expected, observed: room.state, pass: room.state === expected });
}
function restoreGuest() {
  manager.markOffline(room.code, b.id);
  // session:hello clears the reloading viewer's file handle before reconnectUser.
  b.fileInfo = undefined;
  manager.reconnectUser(room.code, b.id, socket());
}
a.fileInfo = movie;
b.fileInfo = movie;
room.state = 'playing';
restoreGuest();
record('reload-requires-file-reselection', 'selecting');
b.fileInfo = { ...movie, size: movie.size + 1 };
manager.markOffline(room.code, a.id);
manager.reconnectUser(room.code, a.id, socket());
record('online-with-mismatched-files', 'selecting');
b.fileInfo = movie;
manager.markOffline(room.code, a.id);
manager.reconnectUser(room.code, a.id, socket());
record('two-online-and-matched', 'playing');
manager.markOffline(room.code, b.id);
manager.forceRemove(room.code, b.id);
record('only-online-host-after-guest-expiry', 'waiting');
manager.joinRoom(room.code, 'viewer-c', socket());
record('replacement-viewer-arrives', 'selecting');
console.log(JSON.stringify({ sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
  node: process.version, checks, passed: checks.filter(check => check.pass).length }, null, 2));
