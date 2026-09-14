import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { createTransferCoordinator, createBackgroundNntpClient } from '../src/lib/server/background-transfer.js';

const settings = { usenetHost: 'provider', usenetUser: 'user', maxConnections: 2 };
const healthy = { playing: true, readyState: 4, bufferedAhead: 40 };

test('background work needs fresh buffer evidence from every active viewer', () => {
  let now = 0;
  const gate = createTransferCoordinator({ now: () => now });
  assert.equal(gate.safe('one'), false);
  gate.report('one', healthy);
  assert.equal(gate.safe('one'), true);
  gate.report('two', { ...healthy, bufferedAhead: 5 });
  assert.equal(gate.safe('one'), false);
  gate.report('two', healthy);
  assert.equal(gate.safe('one'), true);
  now = 10001;
  assert.equal(gate.safe('one'), false);
});

test('foreground requests interrupt background work and take the released connection first', async () => {
  const gate = createTransferCoordinator({ wait: setImmediate });
  gate.report('watch', healthy);
  const job = { backgroundFor: 'watch' };
  let interrupted = false;
  const releaseBackground = await gate.acquire(settings, job, () => { interrupted = true; releaseBackground(); });
  const foreground = await gate.acquire(settings);
  assert.equal(interrupted, true);
  const secondForeground = await gate.acquire(settings);
  let admitted = false;
  const pending = gate.acquire(settings, job).then(release => { admitted = true; return release; });
  await setImmediate();
  assert.equal(admitted, false, 'background cannot exceed the provider connection budget');
  foreground();
  const release = await pending;
  release(); secondForeground();
});

test('buffering, pausing and seeking interrupt an active background article', async () => {
  for (const change of [{ bufferedAhead: 3 }, { playing: false }, { seeking: true }, { readyState: 2 }]) {
    const gate = createTransferCoordinator();
    gate.report('watch', healthy);
    let interrupted = false;
    const release = await gate.acquire(settings, { backgroundFor: 'watch' }, () => { interrupted = true; });
    gate.report('watch', { ...healthy, ...change });
    assert.equal(interrupted, true);
    release();
  }
});

test('only one background transfer runs and queued cancellation needs no socket', async () => {
  const gate = createTransferCoordinator({ wait: setImmediate });
  gate.report('watch', healthy);
  const release = await gate.acquire(settings, { backgroundFor: 'watch' });
  const queued = { backgroundFor: 'watch' };
  const pending = gate.acquire(settings, queued);
  queued.cancelled = true;
  await assert.rejects(pending, { code: 'DOWNLOAD_CANCELLED' });
  release();
  gate.pause();
  assert.equal(gate.safe('watch'), false);
});

test('foreground preemption retries an article without delivering partial or duplicate bytes', async () => {
  const gate = createTransferCoordinator({ wait: setImmediate });
  gate.report('watch', healthy);
  let connections = 0, started, rejectRead;
  const reading = new Promise(resolve => { started = resolve; });
  const client = createBackgroundNntpClient({ ...settings, backgroundJob: { backgroundFor: 'watch' } }, gate, async () => {
    const first = ++connections === 1;
    const socket = new EventEmitter();
    socket.closed = false;
    socket.destroy = () => { socket.closed = true; socket.emit('close'); rejectRead?.(new Error('interrupted')); };
    return {
      socket,
      close() { socket.closed = true; socket.emit('close'); },
      async body(id, line) {
        assert.equal(id, 'article');
        await line('first half');
        if (first) return new Promise((resolve, reject) => { rejectRead = reject; started(); });
        await line('second half');
      }
    };
  });
  const delivered = [];
  const download = client.body('article', line => delivered.push(line));
  await reading;
  const release = await gate.acquire(settings);
  assert.deepEqual(delivered, []);
  release();
  await download;
  assert.deepEqual(delivered, ['first half', 'second half']);
  assert.equal(connections, 2);
  client.close();
});

test('queued background download resumes when the viewer leaves and its report expires', async () => {
  let now = 0;
  const gate = createTransferCoordinator({ now: () => now, wait: setImmediate });
  gate.report('watch', { playing: false });
  const job = { backgroundFor: 'watch', message: 'Downloading the next episode…' };
  let admitted = false;
  const pending = gate.acquire(settings, job).then(release => { admitted = true; release(); });
  await setImmediate();
  assert.equal(admitted, false);
  now = 10001;
  await setImmediate();
  if (!admitted) job.cancelled = true;
  await pending.catch(error => { assert.equal(error.code, 'DOWNLOAD_CANCELLED'); });
  assert.equal(admitted, true, 'an absent viewer must not pause the download forever');
  assert.equal(job.message, 'Downloading the next episode…');
});

test('idle downloads still yield to foreground transfers and explicit settings suspension', async () => {
  const gate = createTransferCoordinator({ wait: setImmediate });
  const foreground = await gate.acquire(settings);
  let admitted = false;
  const pending = gate.acquire(settings, { backgroundFor: 'departed' }).then(release => { admitted = true; release(); });
  await setImmediate();
  assert.equal(admitted, false, 'a free slot must not bypass active foreground work without buffer evidence');
  gate.pause();
  foreground();
  await setImmediate();
  assert.equal(admitted, false, 'turning off automatic downloads is not an expired viewer');
  gate.resume();
  await pending;
  assert.equal(admitted, true);
});

test('a remaining unhealthy viewer blocks an orphaned download until its buffer recovers', async () => {
  const gate = createTransferCoordinator({ wait: setImmediate });
  gate.report('other', { ...healthy, bufferedAhead: 3 });
  let admitted = false;
  const pending = gate.acquire(settings, { backgroundFor: 'departed' }).then(release => { admitted = true; release(); });
  await setImmediate();
  assert.equal(admitted, false);
  gate.report('other', healthy);
  await pending;
  assert.equal(admitted, true);
});
