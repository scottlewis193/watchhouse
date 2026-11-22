import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { createTransferCoordinator, createBackgroundNntpClient } from '../src/lib/server/background-transfer.js';

const settings = { usenetHost: 'provider', usenetUser: 'user', maxConnections: 2 };
const healthy = { playing: true, readyState: 4, bufferedAhead: 40 };

test('an explicit download progresses within a constrained player buffer and yields when it drains', async () => {
  const gate = createTransferCoordinator({ wait: setImmediate });
  const job = { offlineDownload: true };
  gate.report('watch', { ...healthy, bufferedAhead: 15.709473 });
  let admitted = false, interrupted = false;
  let release;
  const pending = gate.acquire(settings, job, () => { interrupted = true; release(); })
    .then(value => { admitted = true; release = value; });
  await setImmediate();
  if (!admitted) job.cancelled = true;
  await pending.catch(error => { assert.equal(error.code, 'DOWNLOAD_CANCELLED'); });
  assert.equal(admitted, true, 'a playing viewer with a healthy 15-second buffer must not starve the download');
  gate.report('watch', { ...healthy, bufferedAhead: 5 });
  assert.equal(interrupted, true, 'the download must yield before the viewer runs out of buffered video');
});

test('foreground requests share spare capacity and preempt background work only when full', async () => {
  const gate = createTransferCoordinator({ wait: setImmediate });
  gate.report('watch', healthy);
  const job = { offlineDownload: true };
  let interrupted = false;
  const releaseBackground = await gate.acquire(settings, job, () => { interrupted = true; releaseBackground(); });
  const foreground = await gate.acquire(settings);
  assert.equal(interrupted, false, 'spare provider capacity must not interrupt the background article');
  const secondForeground = await gate.acquire(settings);
  assert.equal(interrupted, true, 'foreground must reclaim background capacity when the provider is full');
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
    const release = await gate.acquire(settings, { offlineDownload: true }, () => { interrupted = true; });
    gate.report('watch', { ...healthy, ...change });
    assert.equal(interrupted, true);
    release();
  }
});

test('only one background transfer runs and queued cancellation needs no socket', async () => {
  const gate = createTransferCoordinator({ wait: setImmediate });
  gate.report('watch', healthy);
  const release = await gate.acquire(settings, { offlineDownload: true });
  const queued = { offlineDownload: true };
  const pending = gate.acquire(settings, queued);
  queued.cancelled = true;
  await assert.rejects(pending, { code: 'DOWNLOAD_CANCELLED' });
  release();
});

test('foreground preemption retries an article without delivering partial or duplicate bytes', { timeout: 2000 }, async () => {
  const gate = createTransferCoordinator({ wait: setImmediate });
  gate.report('watch', healthy);
  const capacity = { ...settings, maxConnections: 1 };
  let connections = 0, started, rejectRead;
  const reading = new Promise(resolve => { started = resolve; });
  const client = createBackgroundNntpClient({ ...capacity, backgroundJob: { offlineDownload: true } }, gate, async () => {
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
  const release = await gate.acquire(capacity);
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
  const job = { offlineDownload: true, message: 'Downloading a copy for offline playback…' };
  let admitted = false;
  const pending = gate.acquire(settings, job).then(release => { admitted = true; release(); });
  await setImmediate();
  assert.equal(admitted, false);
  now = 10001;
  await setImmediate();
  if (!admitted) job.cancelled = true;
  await pending.catch(error => { assert.equal(error.code, 'DOWNLOAD_CANCELLED'); });
  assert.equal(admitted, true, 'an absent viewer must not pause the download forever');
  assert.equal(job.message, 'Downloading a copy for offline playback…');
});

test('idle downloads still yield to foreground transfers', async () => {
  const gate = createTransferCoordinator({ wait: setImmediate });
  const foreground = await gate.acquire(settings);
  let admitted = false;
  const pending = gate.acquire(settings, { offlineDownload: true }).then(release => { admitted = true; release(); });
  await setImmediate();
  assert.equal(admitted, false, 'a free slot must not bypass active foreground work without buffer evidence');
  foreground();
  await pending;
  assert.equal(admitted, true);
});

test('a download waits until every active viewer has a healthy buffer', async () => {
  const gate = createTransferCoordinator({ wait: setImmediate });
  gate.report('watch', healthy);
  gate.report('other', { ...healthy, bufferedAhead: 3 });
  let admitted = false;
  const pending = gate.acquire(settings, { offlineDownload: true }).then(release => { admitted = true; release(); });
  await setImmediate();
  assert.equal(admitted, false);
  gate.report('other', healthy);
  await pending;
  assert.equal(admitted, true);
});
