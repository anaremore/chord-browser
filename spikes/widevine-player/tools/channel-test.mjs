// Plain-Node check of the control channel: handshake, round trips, and that a
// wrong secret or a stray client gets nothing.  node tools/channel-test.mjs
import net from 'node:net';
import { connect, listen, newAddress, newSecret, now } from '../shared/channel.mjs';

const address = newAddress();
const secret = newSecret();
let hostPeer;
const server = await listen(address, secret, (peer) => {
  hostPeer = peer;
  peer.handle('ping', () => ({ t: now() }));
});
const t0 = now();
const peer = await connect(address, secret);
const handshake = now() - t0;
peer.handle('echo', (m) => m.x);

const times = [];
for (let i = 0; i < 500; i++) {
  const t = now();
  await peer.request('ping');
  times.push(now() - t);
}
times.sort((a, b) => a - b);
const result = {
  platform: process.platform,
  handshakeMs: +handshake.toFixed(3),
  rttMedianMs: +times[250].toFixed(3),
  rttP95Ms: +times[475].toFixed(3),
  hostToPlayer: await hostPeer.request('echo', { x: 42 }),
};

// A second client while one is connected is dropped; so is a wrong secret.
result.secondClient = await connect(address, secret).then(() => 'connected (bad)', (e) => `refused: ${e.message}`);
peer.close();
await new Promise((r) => setTimeout(r, 100));
result.wrongSecret = await connect(address, newSecret()).then(() => 'connected (bad)', (e) => `refused: ${e.message}`);
// A client that says nothing is cut off after the handshake timeout.
result.silentClient = await new Promise((resolve) => {
  const started = now();
  const s = net.connect(address.path);
  s.on('data', () => {});
  s.on('close', () => resolve(`closed after ${Math.round(now() - started)} ms`));
});
console.log(JSON.stringify(result, null, 2));
server.close();
address.cleanup();
