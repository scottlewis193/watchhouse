import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePlayback, createPlaybackPlanCache } from '../src/lib/server/streamer.js';
import { createPlaybackPersistence } from '../src/lib/server/playback-persistence.js';

const media = { type: 'movie', id: 1, title: 'Film', year: '2024' };
const settings = { usenetHost: 'fixture', playbackQuality: 'quality', targetResolution: '1080p', maxConnections: 4 };
const archives = [{ subject: 'film.part1.rar', segments: [{ id: 'volume@fixture', number: 1, bytes: 1000 }] }];
const release = 'Film.2024.1080p.BluRay.x264-Saved';
const health = { has: async () => false, get: async () => null, reject: async () => {} };
const source = () => ({ randomAccess: true, complete: true, closed: false, failure: null, async close() { this.closed = true; } });

for (const fails of [false, true]) test(`saved successful archive ${fails ? 'falls back to search after fresh validation fails' : 'opens and validates before any search'}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-plan-selection-'));
  try {
    await createPlaybackPersistence(root).setPlan(media, settings, { archives, release, strategy: 'remux' });
    const persistence = createPlaybackPersistence(root), calls = [], opened = source();
    const job = { id: 'fixture', media, events: [] };
    await preparePlayback(job, settings, {
      persistence, health, plans: createPlaybackPlanCache(), archivePlans: { get() { return null; }, delete() {} }, hints: null,
      progressive: async (job, _settings, saved) => {
        calls.push('open'); assert.deepEqual(saved, archives);
        Object.assign(job, { archiveSource: opened, progressiveArchive: true, file: { subject: 'film.mkv' }, strategy: 'remux', mode: 'direct' });
        return true;
      },
      preflight: async job => { calls.push(`validate:${job.release}`); if (fails && job.release === release) throw Object.assign(new Error('Opening timeline has a gap'), { code: 'INVALID_MEDIA_TIMELINE' }); return { close: async () => {} }; },
      search: async () => { calls.push('search'); return [{ title: 'Film.2024.1080p.BluRay.x264-Fallback', nzbUrl: 'https://fixture.invalid/nzb' }]; },
      load: async () => '<nzb><file subject="film.mkv"><segments><segment bytes="1000" number="1">video@fixture</segment></segments></file></nzb>',
      check: async () => Buffer.from('opening'), connectAhead: null, archiveCheck: null, archiveHeader: null,
      cache: async () => { throw new Error('Unexpected full download'); }
    });
    assert.deepEqual(calls, fails ? ['open', `validate:${release}`, 'search', 'validate:Film.2024.1080p.BluRay.x264-Fallback'] : ['open', `validate:${release}`]);
    assert.equal(job.status, 'ready');
    assert.equal(job.release, fails ? 'Film.2024.1080p.BluRay.x264-Fallback' : release);
    assert.equal(opened.closed, fails);
    if (!fails) assert.ok(job.events.some(event => event.activity === 'persistent-archive-plan-hit'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const playable of [true, false]) test(`explicit Play preparation ${playable ? 'can reach a working third candidate' : 'stops provider work after three failed candidates'}`, async () => {
  const loaded = [], candidates = Array.from({ length: 5 }, (_, index) => ({
    title: `Film.2024.1080p.BluRay.x264-Choice${index + 1}`, nzbUrl: `https://fixture.invalid/${index + 1}`
  }));
  const job = { id: 'intent-fixture', media, speculative: true, playIntent: true, events: [] };
  await preparePlayback(job, settings, {
    persistence: null, health, plans: createPlaybackPlanCache(), archivePlans: { get() { return null; }, delete() {} }, hints: null,
    search: async () => candidates,
    load: async release => {
      loaded.push(release.title);
      return playable && release === candidates[2]
        ? '<nzb><file subject=\"film.part1.rar\"><segments><segment bytes=\"1000\" number=\"1\">volume@fixture</segment></segments></file></nzb>' : '<nzb></nzb>';
    },
    progressive: async job => {
      Object.assign(job, { archiveSource: source(), progressiveArchive: true, file: { subject: 'film.mkv' }, strategy: 'remux', mode: 'direct' });
      return true;
    },
    preflight: async () => ({ close: async () => {} }),
    check: async () => Buffer.from('opening'), connectAhead: null, archiveCheck: null, archiveHeader: null,
    archive: async () => { throw new Error('Intent must not download a full archive'); },
    cache: async () => { throw new Error('Intent must not download a full video'); }
  });
  assert.deepEqual(loaded, candidates.slice(0, 3).map(release => release.title));
  assert.equal(job.status, playable ? 'ready' : 'error');
  if (playable) assert.equal(job.release, candidates[2].title);
});
