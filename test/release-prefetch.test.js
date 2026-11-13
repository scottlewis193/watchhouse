import test from 'node:test';
import assert from 'node:assert/strict';
import { prefetchReleaseDescriptions } from '../src/lib/server/release-prefetch.js';

function description() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function manualClock() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay) {
      timers.set(++id, { callback, at: time + delay });
      return id;
    },
    clearTimeout(timer) { timers.delete(timer); },
    advance(milliseconds) {
      time += milliseconds;
      for (const [timer, { callback, at }] of timers) {
        if (at > time) continue;
        timers.delete(timer);
        callback();
      }
    },
    get activeTimers() { return timers.size; }
  };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('stops unused NZB requests when selection exits early', async () => {
  const started = [], cancelled = [];
  for await (const result of prefetchReleaseDescriptions([0, 1, 2, 3, 4], (release, signal) => {
    started.push(release);
    if (release === 0) return 'chosen';
    return new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled.push(release); reject(new Error('cancelled')); }, { once: true }));
  })) {
    assert.equal(result.value, 'chosen');
    break;
  }
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(cancelled, [1, 2]);
});

test('keeps failed requests in ranking order and supports serial background lookup', async () => {
  const visited = [], failure = new Error('NZB unavailable');
  for await (const result of prefetchReleaseDescriptions([0, 1, 2], async release => {
    visited.push(release);
    if (release === 1) throw failure;
    return `NZB ${release}`;
  }, 1)) {
    assert.equal(visited.length, result.index + 1);
    if (result.index === 1) assert.equal(result.error, failure);
    else assert.equal(result.value, `NZB ${result.index}`);
  }
});

test('defers a slow description after one grace period and retains it when prepared alternatives are rejected', async () => {
  const slow = description(), later = description(), clock = manualClock();
  const iterator = prefetchReleaseDescriptions([0, 1, 2], release => {
    if (release === 0) return slow.promise;
    if (release === 2) return later.promise;
    return 'first prepared';
  }, 3, undefined, undefined, { deferSlow: true, readinessKey: () => 'same tier', clock });
  let first;
  const firstNext = iterator.next().then(result => { first = result; });
  await nextTurn();
  clock.advance(1499);
  await nextTurn();
  assert.equal(first, undefined, 'a prepared alternative must not shorten the default grace');
  clock.advance(1);
  await nextTurn();
  assert.deepEqual(first, { done: false, value: { index: 1, value: 'first prepared' } });
  await firstNext;
  assert.equal(clock.activeTimers, 0);

  // Asking for another result models rejecting the first prepared description.
  let second;
  const secondNext = iterator.next().then(result => { second = result; });
  await nextTurn();
  later.resolve('second prepared');
  await nextTurn();
  assert.deepEqual(second, { done: false, value: { index: 2, value: 'second prepared' } });
  await secondNext;
  assert.equal(clock.activeTimers, 0, 'the original slow request must not receive another grace period');

  const fallback = iterator.next();
  slow.resolve('slow fallback');
  assert.deepEqual(await fallback, { done: false, value: { index: 0, value: 'slow fallback' } });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

for (const outcome of ['value', 'error']) {
  test(`preserves the ranked ${outcome} when the preferred description settles within grace`, async () => {
    const slow = description(), clock = manualClock(), failure = new Error('preferred NZB failed');
    const iterator = prefetchReleaseDescriptions([0, 1], release => release === 0 ? slow.promise : 'prepared', 2,
      undefined, undefined, { deferSlow: true, readinessKey: () => 'same tier', clock });
    const first = iterator.next();
    await nextTurn();
    clock.advance(1499);
    if (outcome === 'error') slow.reject(failure);
    else slow.resolve('preferred');
    assert.deepEqual(await first, {
      done: false,
      value: outcome === 'error' ? { index: 0, error: failure } : { index: 0, value: 'preferred' }
    });
    assert.equal(clock.activeTimers, 0, 'settling within grace must clear the unused timer');
    assert.deepEqual(await iterator.next(), { done: false, value: { index: 1, value: 'prepared' } });
    await iterator.return();
  });
}

for (const [boundary, change] of [
  ['quality group', { group: '720p' }],
  ['size tier', { size: 'large' }],
  ['audio tier', { audio: 'transcoded' }],
  ['resolution preference', { resolution: '2160p' }],
  ['playback strategy preference', { strategy: 'hls' }]
]) {
  test(`does not bypass a pending preferred description across a ${boundary}`, async () => {
    const slow = description(), clock = manualClock(), started = [];
    const preferred = { id: 0, group: '1080p', size: 'small', audio: 'direct', resolution: '1080p', strategy: 'mp4' };
    const releases = [preferred, { ...preferred, ...change, id: 1 }];
    const iterator = prefetchReleaseDescriptions(releases, release => {
      started.push(release.id);
      return release.id === 0 ? slow.promise : 'incompatible prepared';
    }, 3, release => release.group, undefined, {
      deferSlow: true,
      readinessKey: release => [release.size, release.audio, release.resolution, release.strategy].join('/'),
      clock
    });
    let first;
    const firstNext = iterator.next().then(result => { first = result; });
    await nextTurn();
    assert.deepEqual(started, boundary === 'quality group' ? [0] : [0, 1]);
    clock.advance(10_000);
    await nextTurn();
    assert.equal(first, undefined);
    assert.equal(clock.activeTimers, 0, 'incompatible preparation must not create a timeout or a polling loop');
    slow.resolve('preferred');
    await firstNext;
    assert.deepEqual(first, { done: false, value: { index: 0, value: 'preferred' } });
    assert.deepEqual(await iterator.next(), { done: false, value: { index: 1, value: 'incompatible prepared' } });
    await iterator.return();
  });
}

for (const mode of ['default', 'disabled', 'missing readiness key', 'unknown readiness key', 'serial']) {
  test(`does not enable slow-description bypass for ${mode} lookup`, async () => {
    const slow = description(), clock = manualClock(), started = [];
    const options = {
      deferSlow: mode !== 'disabled',
      readinessKey: mode === 'missing readiness key' ? undefined : () => mode === 'unknown readiness key' ? undefined : 'same tier',
      softWaitMs: 20,
      clock
    };
    const iterator = prefetchReleaseDescriptions([0, 1], release => {
      started.push(release);
      return release === 0 ? slow.promise : 'prepared';
    }, mode === 'serial' ? 1 : 3, undefined, undefined, mode === 'default' ? undefined : options);
    let first;
    const firstNext = iterator.next().then(result => { first = result; });
    await nextTurn();
    assert.deepEqual(started, mode === 'serial' ? [0] : [0, 1]);
    clock.advance(10_000);
    await nextTurn();
    assert.equal(first, undefined);
    assert.equal(clock.activeTimers, 0);
    slow.resolve('preferred');
    await firstNext;
    assert.deepEqual(first, { done: false, value: { index: 0, value: 'preferred' } });
    await iterator.return();
  });
}

test('never bypasses a pending description with an error and wakes for a later successful preparation', async () => {
  const slow = description(), later = description(), clock = manualClock();
  const alternativeFailure = new Error('alternative NZB failed'), preferredFailure = new Error('preferred NZB failed');
  const iterator = prefetchReleaseDescriptions([0, 1, 2], release => {
    if (release === 0) return slow.promise;
    if (release === 1) throw alternativeFailure;
    return later.promise;
  }, 3, undefined, undefined, { deferSlow: true, softWaitMs: 25, readinessKey: () => 'same tier', clock });
  let first;
  const firstNext = iterator.next().then(result => { first = result; });
  await nextTurn();
  clock.advance(25);
  await nextTurn();
  assert.equal(first, undefined, 'a settled NZB failure is not a prepared winner');
  later.resolve('prepared after grace');
  await nextTurn();
  assert.deepEqual(first, { done: false, value: { index: 2, value: 'prepared after grace' } });
  await firstNext;
  assert.equal(clock.activeTimers, 0);

  const fallback = iterator.next();
  slow.reject(preferredFailure);
  assert.deepEqual(await fallback, { done: false, value: { index: 0, error: preferredFailure } });
  assert.deepEqual(await iterator.next(), { done: false, value: { index: 1, error: alternativeFailure } });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test('waits for the preferred fallback when every prepared alternative fails', async () => {
  const slow = description(), alternative = description(), clock = manualClock();
  const failure = new Error('alternative failed');
  const iterator = prefetchReleaseDescriptions([0, 1], release => release === 0 ? slow.promise : alternative.promise, 2,
    undefined, undefined, { deferSlow: true, softWaitMs: 25, readinessKey: () => 'same tier', clock });
  let first;
  const firstNext = iterator.next().then(result => { first = result; });
  await nextTurn();
  clock.advance(25);
  alternative.reject(failure);
  await nextTurn();
  assert.equal(first, undefined);
  assert.equal(clock.activeTimers, 0);
  slow.resolve('only usable fallback');
  await firstNext;
  assert.deepEqual(first, { done: false, value: { index: 0, value: 'only usable fallback' } });
  assert.deepEqual(await iterator.next(), { done: false, value: { index: 1, error: failure } });
  await iterator.return();
});

test('keeps slow and unused work alive until selection exits, then aborts within the bounded lookahead', async () => {
  const clock = manualClock(), started = [], cancelled = [];
  const iterator = prefetchReleaseDescriptions([0, 1, 2, 3, 4], (release, signal) => {
    started.push(release);
    if (release === 1) return 'chosen alternative';
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      cancelled.push(release);
      reject(new Error('cancelled'));
    }, { once: true }));
  }, 3, undefined, undefined, { deferSlow: true, readinessKey: () => 'same tier', clock });
  let first;
  const firstNext = iterator.next().then(result => { first = result; });
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2]);
  clock.advance(1500);
  await nextTurn();
  assert.deepEqual(first, { done: false, value: { index: 1, value: 'chosen alternative' } });
  await firstNext;
  assert.deepEqual(cancelled, [], 'soft timeout must not abort the fallback or other lookahead');
  assert.equal(clock.activeTimers, 0);
  await iterator.return();
  assert.deepEqual(started, [0, 1, 2], 'early exit must not start another lookahead window');
  assert.deepEqual(cancelled, [0, 2]);
  assert.equal(clock.activeTimers, 0);
});

test('ignores already prepared incompatible work while awaiting a compatible success after grace', async () => {
  const slow = description(), compatible = description(), clock = manualClock();
  const iterator = prefetchReleaseDescriptions([0, 1, 2], release => {
    if (release === 0) return slow.promise;
    if (release === 1) return 'different audio tier';
    return compatible.promise;
  }, 3, undefined, undefined, {
    deferSlow: true,
    readinessKey: release => release === 1 ? 'transcoded audio' : 'direct audio',
    clock
  });
  let first;
  const firstNext = iterator.next().then(result => { first = result; });
  await nextTurn();
  clock.advance(1500);
  await nextTurn();
  assert.equal(first, undefined);
  compatible.resolve('compatible prepared');
  await nextTurn();
  assert.deepEqual(first, { done: false, value: { index: 2, value: 'compatible prepared' } });
  await firstNext;
  const fallback = iterator.next();
  slow.resolve('preferred');
  assert.deepEqual(await fallback, { done: false, value: { index: 0, value: 'preferred' } });
  assert.deepEqual(await iterator.next(), { done: false, value: { index: 1, value: 'different audio tier' } });
  await iterator.return();
});

test('chooses the highest ranked prepared compatible alternative rather than the earliest completion', async () => {
  const slow = description(), higherRanked = description(), clock = manualClock();
  const iterator = prefetchReleaseDescriptions([0, 1, 2], release => {
    if (release === 0) return slow.promise;
    if (release === 1) return higherRanked.promise;
    return 'prepared first but ranked last';
  }, 3, undefined, undefined, { deferSlow: true, readinessKey: () => 'same tier', clock });
  let first;
  const firstNext = iterator.next().then(result => { first = result; });
  await nextTurn();
  clock.advance(500);
  higherRanked.resolve('higher ranked alternative');
  await nextTurn();
  assert.equal(first, undefined);
  clock.advance(1000);
  await nextTurn();
  assert.deepEqual(first, { done: false, value: { index: 1, value: 'higher ranked alternative' } });
  await firstNext;
  assert.deepEqual(await iterator.next(), { done: false, value: { index: 2, value: 'prepared first but ranked last' } });
  const fallback = iterator.next();
  slow.resolve('preferred fallback');
  assert.deepEqual(await fallback, { done: false, value: { index: 0, value: 'preferred fallback' } });
  await iterator.return();
});

test('preserves dynamic not-started deferral and contiguous quality barriers with slow deferral enabled', async () => {
  const clock = manualClock(), deferred = new Set(), started = [], yielded = [];
  const releases = [0, 1, 2, 3, 4, 5].map(id => ({ id, group: id === 4 ? '720p' : '1080p' }));
  for await (const result of prefetchReleaseDescriptions(releases, release => {
    started.push(release.id);
    return `prepared ${release.id}`;
  }, 2, release => release.group, release => deferred.has(release.id), {
    deferSlow: true, readinessKey: release => release.group, clock
  })) {
    yielded.push(result.index);
    if (result.index === 0) deferred.add(2);
  }
  assert.deepEqual(started, [0, 1, 3, 2, 4, 5]);
  assert.deepEqual(yielded, [0, 1, 3, 2, 4, 5]);
  assert.equal(clock.activeTimers, 0);
});
