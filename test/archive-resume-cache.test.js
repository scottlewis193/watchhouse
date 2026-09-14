import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveResumeCache } from '../src/lib/server/archive-resume-cache.js';
import { preparePlayback, createPlaybackPlanCache } from '../src/lib/server/streamer.js';
const media = { type: 'tv', id: 95480, season: 1, episode: 2 };
function fixture() {
  let leases = 0;
  const source = { metadata: { size: 100 }, closed: false, failure: null, retain() { leases++; return { close() { leases--; } }; } };
  return { source, leases: () => leases, plan: { archiveSource: source, progressiveArchive: true, file: { subject: 'episode.mkv' }, archives: [], release: 'Archive', strategy: 'remux' } };
}
test('archive resume reuses extraction without repeating release search', async () => {
  const cache = createArchiveResumeCache(), f = fixture();
  try {
    cache.set(media, 'scope', f.plan);
    const job = { media, events: [], diagnosticsEnabled: true };
    await preparePlayback(job, {}, { archivePlans: { get: () => cache.get(media, 'scope') }, plans: createPlaybackPlanCache(), health: { has: async () => false }, search: async () => { throw Error('Repeated search'); } });
    assert.equal(job.status, 'ready');
    assert.equal(job.archiveSource, f.source);
    assert.equal(job.file, f.plan.file);
    assert.ok(job.events.some(e => e.activity === 'archive-resume-hit'));
  } finally { cache.clear(); }
  assert.equal(f.leases(), 0);
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
