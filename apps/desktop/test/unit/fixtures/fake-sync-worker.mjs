/**
 * A stand-in for sync's worker thread (src/data/sync-worker.ts), for the
 * controller's tests: it answers each folder operation from a plan in
 * CHORD_FAKE_SYNC (JSON: for `write` and `snapshot`, what each answers in
 * turn), and touches no folder.
 */
import { parentPort } from 'node:worker_threads';

const plan = JSON.parse(process.env['CHORD_FAKE_SYNC'] ?? '{}');
const next = (kind) => (plan[kind]?.length ? plan[kind].shift() : 'ok');
let device = '';
let segment = 1;

parentPort.on('message', (message) => {
  switch (message.t) {
    case 'start':
      device = message.device;
      return;
    case 'read':
      parentPort.postMessage({ t: 'pass-done', look: { state: 'ok' }, seen: {}, wrote: {}, tooMany: false, cluttered: false, unfinished: false });
      return;
    case 'unlock':
      parentPort.postMessage({ t: 'unlocked', key: new Uint8Array(32).fill(7), generation: 1 });
      return;
    case 'write': {
      const answer = next('write');
      if (answer === 'ok') parentPort.postMessage({ t: 'written', upto: message.upto, own: { generation: 1, device, segment, size: 200, frames: 2, closed: [] }, frames: 1, bytes: 100 });
      else parentPort.postMessage({ t: 'failed', problem: answer, for: 'write' });
      return;
    }
    case 'snapshot': {
      const answer = next('snapshot');
      if (answer !== 'ok') return parentPort.postMessage({ t: 'failed', problem: answer, for: 'snapshot' });
      if (message.as) device = message.as;
      segment++;
      parentPort.postMessage({ t: 'snapshotted', own: { generation: 1, device, segment, size: 100, frames: 1, closed: [] } });
      return;
    }
    default:
      return;
  }
});
