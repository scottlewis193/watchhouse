import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveResumeCache } from '../src/lib/server/archive-resume-cache.js';
import { preparePlayback, createPlaybackPlanCache, clearWatchedPlaybackWarmth, shouldClearPlaybackWarmth } from '../src/lib/server/streamer.js';
const media = { type: 'tv', id: 95480, season: 1, episode: 2 };
function fixture() {
  let holds = 0, consumers = 0;
  const source = {
    metadata: { size: 100 }, closed: false, failure: null,
    get consumers() { return consumers; },
    retain() { consumers++; return { close() { consumers--; } }; },
    hold() { holds++; return { close() { holds--; } }; }
  };
  return { source, leases: () => holds, plan: { archiveSource: source, progressiveArchive: true, file: { subject: 'episode.mkv' }, archives: [], release: 'Archive', strategy: 'remux' } };
}
test('archive resume reuses extraction without repeating release search', async () => {
  for (const speculative of [false, true]) {
    const cache = createArchiveResumeCache(), f = fixture();
    try {
      cache.set(media, 'scope', f.plan);
      const job = { media, speculative, events: [], diagnosticsEnabled: true };
      await preparePlayback(job, {}, { archivePlans: { get: () => cache.get(media, 'scope') }, plans: createPlaybackPlanCache(), health: { has: async () => false }, search: async () => { throw Error('Repeated search'); } });
      assert.equal(job.status, 'ready');
      assert.equal(job.archiveSource, f.source);
      assert.equal(job.file, f.plan.file);
      assert.ok(job.events.some(e => e.activity === 'archive-resume-hit'));
    } finally { cache.clear(); }
    assert.equal(f.leases(), 0);
  }
});

test('a slow resumed 2160p archive falls back to a playable 1080p release', async () => {
  const f = fixture(), checked = [], rejected = [];
  const archive = { ...f.plan, release: 'Film.2160p', releaseKey: 'Film.2160p' };
  let cleared = false;
  const job = { media, selectionStart: 6817, status: 'selecting', diagnosticsEnabled: true, events: [] };
  await preparePlayback(job, { usenetHost: 'fixture', targetResolution: '2160p' }, {
    archivePlans: { get: () => cleared ? null : archive, delete: () => { cleared = true; } },
    plans: createPlaybackPlanCache(),
    health: { has: async () => false, reject: async (_settings, _media, release) => { rejected.push(release); } },
    search: async () => [{ title: 'Film.1080p' }],
    load: async () => '<nzb><file subject="film.mkv"><segments><segment number="1">article</segment></segments></file></nzb>',
    check: async () => Buffer.from('video'),
    preflight: async (candidate, _settings, start, options) => {
      checked.push({ release: candidate.release, start, firstSegmentMs: options.firstSegmentMs });
      if (candidate.release === 'Film.2160p') throw Object.assign(new Error('converter produced 0.8× video'), { code: 'PLAYBACK_TOO_SLOW' });
      return { sessionUrl: '/prepared/1080p', start };
    }
  });
  assert.deepEqual(checked.map(value => value.release), ['Film.2160p', 'Film.1080p']);
  assert.equal(checked[0].start, 6817);
  assert.equal(checked[0].firstSegmentMs, 20000);
  assert.deepEqual(rejected, ['Film.2160p']);
  assert.equal(cleared, true);
  assert.equal(job.status, 'ready');
  assert.equal(job.release, 'Film.1080p');
  assert.equal(job.preparedSession.sessionUrl, '/prepared/1080p');
});

test('a poster-prepared archive is checked after play is pressed', async () => {
  const f = fixture();
  const job = { media, selectionStart: 6817, status: 'selecting', mode: 'direct', archiveNeedsCheck: true,
    progressiveArchive: true, archiveSource: f.source, file: f.plan.file, release: 'Film.2160p', strategy: 'transcode' };
  let checked = 0;
  await preparePlayback(job, { usenetHost: 'fixture' }, {
    preflight: async (_candidate, _settings, start) => { checked++; assert.equal(start, 6817); return { sessionUrl: '/prepared/2160p' }; },
    search: async () => { throw new Error('Poster source was searched again.'); }
  });
  assert.equal(checked, 1);
  assert.equal(job.status, 'ready');
  assert.equal(job.preparedSession.sessionUrl, '/prepared/2160p');
});
test('archive retention is scoped, bounded and releases expired or failed sources', () => {
  let now = 0;
  const cache = createArchiveResumeCache({ now: () => now, ttl: 100, maximum: 1, maximumBytes: 150 });
  const a = fixture(), b = fixture();
  try {
    cache.set(media, 'one', a.plan);
    assert.equal(cache.get(media, 'two'), undefined);
    cache.set(media, 'two', b.plan);
    assert.equal(a.leases(), 0);
    b.source.failure = Error('failed');
    assert.equal(cache.get(media, 'two'), undefined);
    assert.equal(b.leases(), 0);
    cache.set(media, 'one', a.plan);
    now = 101;
    assert.equal(cache.get(media, 'one'), undefined);
    assert.equal(a.leases(), 0);
    a.source.metadata.size = 151;
    cache.set(media, 'one', a.plan);
    assert.equal(a.leases(), 0);
  } finally { cache.clear(); }
});

test('production archive retention has no arbitrary title, byte or idle cap', () => {
  let now = 0;
  const cache = createArchiveResumeCache({ now: () => now });
  const fixtures = Array.from({ length: 6 }, () => fixture());
  for (let index = 0; index < fixtures.length; index++) {
    fixtures[index].source.metadata.size = 10 * 1024 ** 3;
    cache.set({ ...media, episode: index + 1 }, 'scope', fixtures[index].plan);
  }
  now = Number.MAX_SAFE_INTEGER;
  for (let index = 0; index < fixtures.length; index++) {
    assert.equal(cache.get({ ...media, episode: index + 1 }, 'scope'), fixtures[index].plan);
  }
  cache.clear();
  assert.ok(fixtures.every(value => value.leases() === 0));
});

test('marking watched clears warm extraction without touching offline storage', () => {
  const deleted = [], posterKeys = [];
  clearWatchedPlaybackWarmth(media, {}, {
    archivePlans: { delete: value => deleted.push(value) },
    poster: { delete: key => posterKeys.push(key) }
  });
  assert.deepEqual(deleted, [media]);
  assert.equal(posterKeys.length, 1);
});

test('clearing progress also clears warm extraction state', () => {
  assert.equal(shouldClearPlaybackWarmth({ reset: true, watched: false }), true);
  assert.equal(shouldClearPlaybackWarmth({ watched: true }), true);
  assert.equal(shouldClearPlaybackWarmth({ position: 0, watched: false }), false);
});

test('rejected archives and download requests do not reuse the streaming cache', async () => {
  for (const flags of [{ rejectedReleases: new Set(['Archive']) }, { offlineDownload: true }, { prepareAhead: true }, { manualRelease: { title: 'Explicit' } }]) {
    const f = fixture(); let searched = false;
    const job = { media, ...flags };
    await preparePlayback(job, {}, {
      archivePlans: { get: () => f.plan }, plans: createPlaybackPlanCache(), health: { has: async () => false },
      search: async () => { searched = true; return []; }, load: async () => { throw Error('manual source checked'); }
    });
    assert.notEqual(job.archiveSource, f.source);
    if (!flags.manualRelease) assert.equal(searched, true);
  }
});

test('clears retained extraction for only the selected episode', () => {
  const cache = createArchiveResumeCache(), first = fixture(), second = fixture(), other = { ...media, episode: 3 };
  cache.set(media, 'scope', first.plan);
  cache.set(other, 'scope', second.plan);
  cache.delete(media);
  assert.equal(first.leases(), 0);
  assert.equal(second.leases(), 1);
  assert.equal(cache.get(media, 'scope'), undefined);
  assert.equal(cache.get(other, 'scope'), second.plan);
  cache.clear();
});
