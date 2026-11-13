import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseHints } from '../src/lib/server/release-hints.js';
import { releaseIdentity } from '../src/lib/server/release-health.js';
import { preparePlayback, createPlaybackPlanCache } from '../src/lib/server/streamer.js';

const provider = { usenetHost: 'provider', usenetUser: 'account', usenetPass: 'password' };
const release = (title, preference = '1080p-small') => ({ title, preference, nzbUrl: `https://indexer.example/${title}` });

test('availability and response time only reorder equivalent candidates, retaining negative fallbacks', () => {
  const hints = createReleaseHints().forProvider(provider);
  const items = [release('High', '2160p-small'), release('Unknown'), release('Slow'), release('Fast'), release('Missing'), release('Large', '1080p-large')];
  hints.record(releaseIdentity(items[2]), { available: true, elapsedMs: 1000 });
  hints.record(releaseIdentity(items[3]), { available: true, elapsedMs: 100 });
  hints.record(releaseIdentity(items[4]), { available: false });
  hints.record(releaseIdentity(items[5]), { available: true, elapsedMs: 1 });
  assert.deepEqual(hints.order(items, item => item.preference).map(item => item.title), ['High', 'Fast', 'Slow', 'Unknown', 'Missing', 'Large']);
});

test('provider credentials isolate hints and existence expires before response timing', () => {
  let time = 0;
  const store = createReleaseHints({ now: () => time }), hints = store.forProvider(provider);
  hints.record('source', { available: true, elapsedMs: 20 });
  for (const changed of [{ usenetHost: 'other' }, { usenetPort: 119 }, { usenetUser: 'other' }, { usenetPass: 'new' }]) {
    assert.equal(store.forProvider({ ...provider, ...changed }).get('source'), null);
  }
  time = 30000;
  assert.deepEqual(hints.get('source'), { available: null, elapsedMs: 20 });
  time = 120000;
  assert.equal(hints.get('source'), null);
});

test('bounded eviction and clearing remove stale provider knowledge', () => {
  const store = createReleaseHints({ maximum: 2 }), hints = store.forProvider(provider);
  for (const id of ['one', 'two', 'three']) hints.record(id, { available: true });
  assert.equal(hints.get('one'), null);
  assert.equal(hints.get('three').available, true);
  store.clear();
  assert.equal(hints.get('three'), null);
});

test('playback prefers a recently available equivalent but still performs live BODY and playback checks', async () => {
  const hints = createReleaseHints(), candidates = ['Unknown', 'Available'].map(name => release(`Film.2024.1080p.H264.${name}`));
  hints.forProvider(provider).record(releaseIdentity(candidates[1]), { available: true });
  const bodyChecks = [], playbackChecks = [], job = { media: { type: 'movie', id: 1, title: 'Film', year: '2024' }, events: [] };
  await preparePlayback(job, provider, {
    hints, search: async () => candidates,
    load: async candidate => `<nzb><file subject="film.mkv"><segments><segment number="1">${candidate.title}</segment></segments></file></nzb>`,
    check: async file => { bodyChecks.push(file.segments[0].id); return Buffer.from('video'); },
    preflight: async candidate => { playbackChecks.push(candidate.release); return { sessionUrl: '/prepared/validated' }; },
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.equal(job.status, 'ready');
  assert.equal(job.release, candidates[1].title);
  assert.ok(bodyChecks.includes(candidates[1].title));
  assert.deepEqual(playbackChecks, [candidates[1].title]);
});
