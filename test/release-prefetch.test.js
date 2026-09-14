import test from 'node:test';
import assert from 'node:assert/strict';
import { prefetchReleaseDescriptions } from '../src/lib/server/release-prefetch.js';

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
