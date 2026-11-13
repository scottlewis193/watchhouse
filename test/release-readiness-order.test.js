import test from 'node:test';
import assert from 'node:assert/strict';
import { prefetchReleaseDescriptions } from '../src/lib/server/release-prefetch.js';

const turn = () => new Promise(resolve => setImmediate(resolve));

async function preparedSelection(releases, options = {}) {
  let releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const signals = [];
  const iterator = prefetchReleaseDescriptions(releases, async (release, signal) => {
    signals.push(signal);
    if (release.id === 0) await first;
    return release;
  }, 4, release => release.tier, undefined, {
    readinessKey: release => release.preference,
    preparedPriority: value => value.cost,
    ...options
  });
  const pending = iterator.next();
  await turn();
  releaseFirst();
  const result = await pending;
  return { iterator, result, signals };
}

const archive = { id: 0, tier: 'small', preference: '1080p/english/remux', cost: 2 };
const direct = { ...archive, id: 1, cost: 0 };

test('prefers an already validated direct source and retains the equivalent archive as fallback', async () => {
  const { iterator, result, signals } = await preparedSelection([archive, direct]);
  try {
    assert.equal(result.value.index, 1);
    assert.equal(signals.some(signal => signal.aborted), false, 'fallback stays alive until selection exits');
    const fallback = await iterator.next();
    assert.equal(fallback.value.index, 0);
  } finally { await iterator.return(); }
  assert.equal(signals.every(signal => signal.aborted), true);
});

for (const preference of ['720p/english/remux', '1080p/dual/remux', '1080p/english/hls']) {
  test(`actual readiness never crosses preference ${preference}`, async () => {
    const { iterator, result } = await preparedSelection([archive, { ...direct, preference }]);
    try { assert.equal(result.value.index, 0); } finally { await iterator.return(); }
  });
}

test('actual readiness never starts work across the configured preset size tier', async () => {
  const { iterator, result, signals } = await preparedSelection([archive, { ...direct, tier: 'oversized' }]);
  try { assert.equal(result.value.index, 0); assert.equal(signals.length, 1); }
  finally { await iterator.return(); }
});

test('equal readiness preserves release rank and disabled readiness preserves manual order', async () => {
  for (const { options, cost } of [{ options: {}, cost: 2 }, { options: { preparedPriority: undefined }, cost: 0 }]) {
    const { iterator, result } = await preparedSelection([archive, { ...direct, cost }], options);
    try { assert.equal(result.value.index, 0); } finally { await iterator.return(); }
  }
});

test('does not wait for a potentially faster candidate that has not finished its checks', async () => {
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const iterator = prefetchReleaseDescriptions([archive, direct], async release => {
    if (release.id === 1) await slow;
    return release;
  }, 2, undefined, undefined, { readinessKey: release => release.preference, preparedPriority: value => value.cost });
  try { assert.equal((await iterator.next()).value.index, 0); }
  finally { releaseSlow(); await iterator.return(); }
});
