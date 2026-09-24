import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NntpClient, preparePlayback, createPlaybackPlanCache } from '../src/lib/server/streamer.js';
import { rankReleases } from '../media.js';

const media = { type: 'tv', id: 95480, title: 'Slow Horses', season: 1, episode: 2 };
const nzb = extension => `<nzb><file subject="episode.${extension}"><segments><segment number="1">article</segment></segments></file></nzb>`;
const job = () => ({ media, events: [], status: 'selecting' });

test('checks later streamable releases before committing to a full archive download', async () => {
  const playback = job();
  let downloads = 0;
  const releases = Array.from({ length: 13 }, (_, index) => ({ title: `Candidate ${index + 1}`, direct: index === 12 }));
  await preparePlayback(playback, {}, {
    search: async () => releases,
    load: async release => nzb(release.direct ? 'mp4' : 'rar'),
    check: async () => Buffer.from('video'),
    archive: async () => { downloads++; },
    health: { has: async () => false },
    plans: createPlaybackPlanCache()
  });
  assert.equal(downloads, 0, 'must not download a whole archive when a later release can stream');
  assert.equal(playback.status, 'ready');
  assert.equal(playback.mode, 'direct');
  assert.equal(playback.release, 'Candidate 13');
});

test('tries the next release when the preferred live conversion cannot sustain playback', async () => {
  const playback = job(), checked = [];
  await preparePlayback(playback, {}, {
    search: async () => [{ title: 'Preferred' }, { title: 'Replacement' }],
    load: async release => nzb('mkv').replace('episode.mkv', `${release.title}.mkv`),
    check: async () => Buffer.from('video'),
    preflight: async candidate => {
      checked.push(candidate.release);
      if (candidate.release === 'Preferred') throw Object.assign(new Error('too slow'), { code: 'PLAYBACK_TOO_SLOW' });
      return { start: 0, sessionUrl: '/prepared/replacement' };
    },
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.deepEqual(checked, ['Preferred', 'Replacement']);
  assert.equal(playback.release, 'Replacement');
  assert.equal(playback.preparedSession.sessionUrl, '/prepared/replacement');
});

test('diagnostics retain every ranked candidate and its live selection outcome', async () => {
  const playback = { ...job(), diagnosticsEnabled: true, selectionStart: 6826 };
  const releases = ['Film.2160p', 'Film.1080p', 'Film.720p', 'Film.480p'].map(title => ({ title, size: 4_000_000_000 }));
  let enteredCheck, completeCheck;
  const checking = new Promise(resolve => { enteredCheck = resolve; });
  const finish = new Promise(resolve => { completeCheck = resolve; });
  const preparation = preparePlayback(playback, { targetResolution: '2160p', playbackQuality: 'quality' }, {
    search: async () => releases,
    load: async () => nzb('mkv'), check: async () => Buffer.from('video'),
    preflight: async candidate => {
      if (candidate.release === 'Film.2160p') throw Object.assign(new Error('too slow'), { code: 'PLAYBACK_TOO_SLOW' });
      enteredCheck();
      await finish;
      return { sessionUrl: '/prepared/1080p' };
    },
    health: { has: async (_settings, _media, release) => release === 'Film.720p' },
    plans: createPlaybackPlanCache()
  });
  await checking;
  assert.deepEqual(playback.releaseSelection.candidates.map(candidate => candidate.status), ['deferred', 'checking', 'skipped', 'queued']);
  assert.match(playback.releaseSelection.candidates[0].reason, /too slow/);
  assert.match(playback.releaseSelection.candidates[2].reason, /cooldown/);
  completeCheck();
  await preparation;
  assert.deepEqual(playback.releaseSelection.candidates.map(candidate => candidate.status), ['deferred', 'selected', 'skipped', 'not-tried']);
  assert.equal(playback.releaseSelection.targetResolution, '2160p');
  assert.equal(playback.releaseSelection.playbackQuality, 'quality');
  assert.equal(playback.releaseSelection.start, 6826);
});

test('poster prewarm checks a direct release before reporting it ready', async () => {
  const playback = { ...job(), speculative: true, selectionStart: 6826 };
  const checked = [];
  await preparePlayback(playback, { targetResolution: '1080p' }, {
    search: async () => [{ title: 'Film.1080p.SDR' }],
    load: async () => nzb('mkv'), check: async () => Buffer.from('video'),
    preflight: async (candidate, _settings, start) => {
      checked.push([candidate.release, start]);
      return { sessionUrl: '/prepared/1080p', start };
    },
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.deepEqual(checked, [['Film.1080p.SDR', 6826]]);
  assert.equal(playback.status, 'ready');
  assert.equal(playback.preparedSession.sessionUrl, '/prepared/1080p');
});

test('poster prewarm rechecks a saved direct plan before reporting it ready', async () => {
  const playback = { ...job(), speculative: true, selectionStart: 6826 };
  let checked = 0;
  await preparePlayback(playback, { targetResolution: '1080p' }, {
    plans: { get: () => ({ release: 'Film.1080p.SDR', strategy: 'transcode', file: { subject: 'film.mkv' }, prefetchedSegments: new Map() }) },
    preflight: async (_candidate, _settings, start) => { checked++; assert.equal(start, 6826); return { sessionUrl: '/prepared/saved' }; },
    health: { has: async () => false }, search: async () => { throw new Error('Unexpected search'); }
  });
  assert.equal(checked, 1);
  assert.equal(playback.status, 'ready');
  assert.equal(playback.preparedSession.sessionUrl, '/prepared/saved');
});

test('falls back from an unplayable 2160p release to 1080p before trying 720p', async () => {
  const playback = job(), checked = [];
  const settings = { targetResolution: '2160p' };
  const candidates = ['720p', '1080p', '2160p'].map(resolution => ({ title: `Slow.Horses.S01E02.${resolution}.mkv` }));
  await preparePlayback(playback, settings, {
    search: async () => rankReleases(candidates, media, settings),
    load: async release => nzb('mkv').replace('episode.mkv', `${release.title}.mkv`),
    check: async () => Buffer.from('video'),
    preflight: async candidate => {
      checked.push(candidate.release);
      if (candidate.release.includes('2160p')) throw Object.assign(new Error('too slow'), { code: 'PLAYBACK_TOO_SLOW' });
      return { start: 0, sessionUrl: '/prepared/1080p' };
    },
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.deepEqual(checked, [candidates[2].title, candidates[1].title]);
  assert.equal(playback.release, candidates[1].title);
  assert.equal(playback.status, 'ready');
});

test('skips HDR tone-mapping releases and selects an SDR fallback', async () => {
  const playback = job(), loaded = [];
  await preparePlayback(playback, { targetResolution: '2160p' }, {
    search: async () => [{ title: 'Film.2160p.HDR10' }, { title: 'Film.1080p.SDR' }],
    load: async release => { loaded.push(release.title); return nzb('mkv'); },
    check: async () => Buffer.from('video'),
    preflight: async () => ({ sessionUrl: '/prepared/sdr' }),
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.deepEqual(loaded, ['Film.1080p.SDR']);
  assert.equal(playback.status, 'ready');
  assert.equal(playback.release, 'Film.1080p.SDR');
});

test('ignores a previously saved HDR source when finding an SDR release', async () => {
  const playback = job(), deleted = [];
  const hdrPlan = { release: 'Film.2160p.HDR10', file: { subject: 'hdr.mkv', segments: [{ id: 'article' }] },
    strategy: 'transcode', prefetchedSegments: new Map() };
  await preparePlayback(playback, { targetResolution: '2160p', usenetHost: 'fixture' }, {
    plans: { get: () => hdrPlan, delete: () => deleted.push('plan') },
    archivePlans: { get: () => ({ ...hdrPlan, archiveSource: { metadata: { size: 100 } }, progressiveArchive: true }), delete: () => deleted.push('archive') },
    search: async () => [{ title: 'Film.1080p.SDR' }], load: async () => nzb('mkv'),
    check: async () => Buffer.from('video'), preflight: async () => ({ sessionUrl: '/prepared/sdr' }),
    health: { has: async () => false }
  });
  assert.deepEqual(deleted, ['plan', 'archive']);
  assert.equal(playback.release, 'Film.1080p.SDR');
});

test('a newly opened 2160p archive must pass the live conversion check before selection', async () => {
  const playback = job(), checked = [], rejected = [];
  await preparePlayback(playback, { usenetHost: 'fixture', targetResolution: '2160p' }, {
    search: async () => [{ title: 'Film.2160p' }, { title: 'Film.1080p' }],
    load: async release => nzb(release.title.includes('2160p') ? 'rar' : 'mkv'),
    check: async () => Buffer.from('video'),
    progressive: async candidate => {
      candidate.progressiveArchive = true;
      candidate.archiveSource = { metadata: { size: 100 }, closed: false };
      candidate.file = { subject: 'film.mkv' };
      candidate.strategy = 'transcode';
      candidate.status = 'ready';
      return true;
    },
    preflight: async candidate => {
      checked.push(candidate.release);
      if (candidate.release.includes('2160p')) throw Object.assign(new Error('too slow'), { code: 'PLAYBACK_TOO_SLOW' });
      return { sessionUrl: '/prepared/1080p' };
    },
    archivePlans: { get: () => null, delete: () => {} },
    health: { has: async () => false, reject: async (_settings, _media, release) => { rejected.push(release); } },
    plans: createPlaybackPlanCache()
  });
  assert.deepEqual(checked, ['Film.2160p', 'Film.1080p']);
  assert.deepEqual(rejected, ['Film.2160p']);
  assert.equal(playback.status, 'ready');
  assert.equal(playback.release, 'Film.1080p');
});

test('stops probing missing archives at one resolution and reaches a later direct release', async () => {
  const playback = { ...job(), diagnosticsEnabled: true }, probed = [];
  const releases = Array.from({ length: 12 }, (_, index) => ({ title: `Film.1080p.Archive${index}` }));
  releases.push({ title: 'Film.1080p.Direct' });
  await preparePlayback(playback, { usenetHost: 'fixture' }, {
    search: async () => releases,
    load: async release => nzb(release.title.endsWith('Direct') ? 'mkv' : 'rar'),
    check: async () => Buffer.from('video'),
    progressive: async candidate => {
      probed.push(candidate.release);
      throw Object.assign(new Error('Missing archive article'), { code: 'ARCHIVE_UNAVAILABLE', unavailableCode: 'USENET_ARTICLE_MISSING' });
    },
    preflight: async () => ({ sessionUrl: '/prepared/direct' }),
    health: { has: async () => false, reject: async () => {} }, plans: createPlaybackPlanCache()
  });
  assert.equal(probed.length, 4);
  assert.equal(playback.status, 'ready');
  assert.equal(playback.release, 'Film.1080p.Direct');
  assert.ok(playback.events.some(event => event.message?.includes('Skipping further archives')));
});

test('checks a targeted 2160p stream live despite one pessimistic provider speed sample', async () => {
  const playback = { ...job(), media: { ...media, durationHint: 60 } }, checked = [];
  await preparePlayback(playback, { targetResolution: '2160p' }, {
    search: async () => [{ title: 'Slow.Horses.S01E02.2160p' }, { title: 'Slow.Horses.S01E02.1080p' }],
    load: async release => nzb('mkv').replace('episode.mkv', `${release.title}.mkv`),
    check: async file => { file.segments[0].decodedBytes = 12_000_000; return Buffer.from('video'); },
    speedMeter: { record() {}, rate: () => 100_000 },
    preflight: async candidate => { checked.push(candidate.release); return { start: 0, sessionUrl: '/prepared/2160p' }; },
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.deepEqual(checked, ['Slow.Horses.S01E02.2160p']);
  assert.equal(playback.release, 'Slow.Horses.S01E02.2160p');
  assert.equal(playback.status, 'ready');
});

test('limits slow-sample 2160p trials before falling back to a playable 1080p release', async () => {
  const playback = { ...job(), media: { ...media, durationHint: 60 } }, checked = [];
  const releases = ['2160p.A', '2160p.B', '2160p.C', '1080p'].map(label => ({ title: `Slow.Horses.S01E02.${label}` }));
  await preparePlayback(playback, { targetResolution: '2160p' }, {
    search: async () => releases,
    load: async release => nzb('mkv').replace('episode.mkv', `${release.title}.mkv`),
    check: async file => { file.segments[0].decodedBytes = file.subject.includes('2160p') ? 12_000_000 : 3_000_000; return Buffer.from('video'); },
    speedMeter: { record() {}, rate: () => 150_000 },
    preflight: async candidate => {
      checked.push(candidate.release);
      if (candidate.release.includes('2160p')) throw Object.assign(new Error('too slow'), { code: 'PLAYBACK_TOO_SLOW' });
      return { start: 0, sessionUrl: '/prepared/1080p' };
    },
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.deepEqual(checked, [releases[0].title, releases[1].title, releases[3].title]);
  assert.equal(playback.release, releases[3].title);
});

test('uses a downloaded copy if sampled provider speed cannot support any candidate', async () => {
  const playback = { ...job(), media: { ...media, durationHint: 60 }, diagnosticsEnabled: true };
  let downloaded = false, preflighted = false;
  await preparePlayback(playback, {}, {
    search: async () => [{ title: 'Large' }], load: async () => nzb('mkv'),
    check: async file => { file.segments[0].decodedBytes = 60_000_000; return Buffer.from('video'); },
    speedMeter: { record() {}, rate: () => 100_000 },
    preflight: async () => { preflighted = true; },
    cache: async candidate => { downloaded = true; candidate.status = 'ready'; candidate.mode = 'cached'; },
    archive: async () => {},
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.equal(preflighted, false);
  const speed = playback.events.find(event => event.activity === 'provider-speed');
  assert.equal(speed.release, 'Large');
  assert.equal(speed.bytesPerSecond, 100_000);
  assert.equal(speed.requiredBytesPerSecond, 1_500_000);
  assert.equal(downloaded, true);
  assert.equal(playback.status, 'ready');
  assert.equal(playback.mode, 'cached');
});

test('best quality verifies a marginal converter instead of rejecting a short startup speed sample', async () => {
  const playback = { ...job(), media: { ...media, durationHint: 60 } };
  let checked = 0;
  await preparePlayback(playback, { playbackQuality: 'quality' }, {
    search: async () => [{ title: 'Marginal 4K' }], load: async () => nzb('mkv'),
    check: async file => { file.segments[0].decodedBytes = 12_000_000; return Buffer.from('video'); },
    speedMeter: { record() {}, rate: () => 250_000 },
    preflight: async () => { checked++; return { start: 0, sessionUrl: '/checked' }; },
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.equal(checked, 1);
  assert.equal(playback.status, 'ready');
  assert.equal(playback.preparedSession.sessionUrl, '/checked');
});

test('best quality gives only the first two stalled transcodes longer to produce a segment', async () => {
  const playback = job(), budgets = [];
  await preparePlayback(playback, { playbackQuality: 'quality' }, {
    search: async () => ['First 4K', 'Second 4K', 'Third 4K'].map(title => ({ title })),
    load: async release => nzb('mkv').replace('episode.mkv', `${release.title}.mkv`),
    check: async () => Buffer.from('video'),
    preflight: async (_candidate, _settings, _start, options) => {
      budgets.push(options.firstSegmentMs);
      if (budgets.length < 3) throw Object.assign(new Error('no first segment'), { code: 'NO_PLAYABLE_SEGMENT' });
      return { start: 0, sessionUrl: '/checked' };
    },
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.deepEqual(budgets, [15000, 15000, 8000]);
  assert.equal(playback.release, 'Third 4K');
});

test('missing articles are remembered across playback attempts, transient failures are retried', async () => {
  const rejected = new Set(), checked = [];
  const releases = [{ title: 'Missing' }, { title: 'Transient' }];
  const deps = {
    search: async () => releases,
    load: async release => { checked.push(release.title); throw Object.assign(new Error('unavailable'), { code: release.title === 'Missing' ? 'USENET_ARTICLE_MISSING' : 'ECONNRESET' }); },
    health: { has: async (_settings, _media, release) => rejected.has(release), reject: async (_settings, _media, release) => rejected.add(release) },
    plans: createPlaybackPlanCache()
  };
  await preparePlayback(job(), {}, deps);
  await preparePlayback(job(), {}, deps);
  assert.deepEqual(checked, ['Missing', 'Transient', 'Transient']);
});

test('NNTP missing-article replies have a distinct code from transient provider failures', async () => {
  for (const status of ['430 No Such Article', '400 Temporarily unavailable']) {
    const socket = new EventEmitter();
    socket.write = () => queueMicrotask(() => socket.emit('data', Buffer.from(`${status}\r\n`)));
    const client = new NntpClient(socket);
    await assert.rejects(client.body('article', () => {}), error => {
      assert.equal(error.code, status.startsWith('430') ? 'USENET_ARTICLE_MISSING' : undefined);
      return true;
    });
  }
});

test('overlaps release descriptions while keeping the highest-ranked playable choice', async () => {
  let releaseFirst, thirdStarted;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const third = new Promise(resolve => { thirdStarted = resolve; });
  const started = [], playback = job();
  const preparation = preparePlayback(playback, {}, {
    search: async () => Array.from({ length: 6 }, (_, index) => ({ title: `Rank ${index}` })),
    load: async release => {
      started.push(release.title);
      if (release.title === 'Rank 2') thirdStarted();
      if (release.title === 'Rank 0') await gate;
      return nzb('mp4');
    },
    check: async () => Buffer.from('video'),
    health: { has: async () => false },
    plans: createPlaybackPlanCache()
  });
  let timer;
  try {
    const overlapped = await Promise.race([third.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 300); })]);
    assert.equal(overlapped, true, 'release descriptions must overlap instead of adding their latencies');
  } finally { clearTimeout(timer); releaseFirst(); await preparation; }
  assert.equal(playback.release, 'Rank 0', 'network completion order must not lower the selected quality');
  assert.deepEqual(started.slice(0, 3), ['Rank 0', 'Rank 1', 'Rank 2']);
  assert.ok(started.length <= 6, 'stop within the bounded lookahead once a playable release is selected');
});

test('availability of the next release overlaps a slow preferred candidate without changing ranking', async () => {
  let finish, secondStarted;
  const blocked = new Promise(resolve => { finish = resolve; });
  const second = new Promise(resolve => { secondStarted = resolve; });
  const playback = job();
  const preparation = preparePlayback(playback, { maxConnections: 4 }, {
    search: async () => [{ title: 'Preferred' }, { title: 'Other' }],
    load: async release => nzb('mp4').replace('episode.mp4', `${release.title}.mp4`),
    check: async file => { if (file.subject.startsWith('Preferred')) await blocked; else secondStarted(); return Buffer.from('video'); },
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  let timer;
  try {
    assert.equal(await Promise.race([second.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 100); })]), true);
    assert.notEqual(playback.status, 'ready');
  } finally { clearTimeout(timer); finish(); await preparation; }
  assert.equal(playback.release, 'Preferred');
});

test('restored plans avoid searching only after a live availability check and fall back when stale', async () => {
  const saved = { file: { subject: 'episode.mp4', segments: [{ id: 'saved', decodedBytes: 4 }] }, release: 'Saved', strategy: 'raw' };
  for (const available of [true, false]) {
    const playback = job();
    let searched = 0, verified = 0;
    await preparePlayback(playback, {}, {
      persistence: { getPlan: async () => structuredClone(saved), setPlan: async () => {} },
      verify: async () => { verified++; return available; },
      search: async () => { searched++; return [{ title: 'Replacement' }]; },
      load: async () => nzb('mp4'), check: async () => Buffer.from('video'),
      health: { has: async () => false }, plans: createPlaybackPlanCache()
    });
    assert.equal(verified, 1);
    assert.equal(searched, available ? 0 : 1);
    assert.equal(playback.status, 'ready');
    assert.equal(playback.release, available ? 'Saved' : 'Replacement');
  }
});

test('a saved lower-resolution fallback does not override a 2160p target on the next play', async () => {
  const saved = { file: { subject: 'episode.mp4', segments: [{ id: 'saved', decodedBytes: 4 }] }, release: 'Slow.Horses.S01E02.1080p', strategy: 'raw' };
  const playback = job();
  let searched = 0, verified = 0;
  await preparePlayback(playback, { targetResolution: '2160p' }, {
    persistence: { getPlan: async () => structuredClone(saved), setPlan: async () => {} },
    verify: async () => { verified++; return true; },
    search: async () => { searched++; return [{ title: 'Slow.Horses.S01E02.2160p' }]; },
    load: async () => nzb('mp4'), check: async () => Buffer.from('video'),
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.equal(verified, 0);
  assert.equal(searched, 1);
  assert.equal(playback.release, 'Slow.Horses.S01E02.2160p');
});

test('slow availability checks do not leave NZB request slots idle', async () => {
  let releaseChecks, loadedSixth;
  const gate = new Promise(resolve => { releaseChecks = resolve; });
  const sixth = new Promise(resolve => { loadedSixth = resolve; });
  let activeLoads = 0, peakLoads = 0;
  const playback = job();
  const preparation = preparePlayback(playback, {}, {
    search: async () => Array.from({ length: 8 }, (_, i) => ({ title: `Rank ${i}` })),
    load: async release => {
      activeLoads++; peakLoads = Math.max(peakLoads, activeLoads);
      await new Promise(resolve => setImmediate(resolve));
      activeLoads--;
      if (release.title === 'Rank 5') loadedSixth();
      return nzb('mp4');
    },
    check: async () => { await gate; return Buffer.from('video'); },
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  let timer;
  try {
    assert.equal(await Promise.race([sixth.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 100); })]), true, 'NZB requests should progress while availability checks wait');
    assert.ok(peakLoads <= 3, 'the HTTP concurrency limit must remain three');
  } finally { clearTimeout(timer); releaseChecks(); await preparation; }
  assert.equal(playback.release, 'Rank 0');
});

test('a later progressive archive is selected before downloading an earlier unsupported archive', async () => {
  const playback = job(), inspected = [], downloaded = [];
  await preparePlayback(playback, {}, {
    search: async () => [{ title: 'Preferred' }, { title: 'Progressive' }],
    load: async () => nzb('rar'), health: { has: async () => false }, plans: createPlaybackPlanCache(),
    progressive: async job => { inspected.push(job.release); if (job.release !== 'Progressive') return false; job.status = 'ready'; return true; },
    archive: async job => { downloaded.push(job.release); }
  });
  assert.deepEqual(inspected, ['Preferred', 'Progressive']);
  assert.deepEqual(downloaded, []);
  assert.equal(playback.release, 'Progressive');
});

test('starts the highest-ranked progressive archive before exhausting lower-ranked releases', async () => {
  let releaseTail;
  const tail = new Promise(resolve => { releaseTail = resolve; });
  const playback = job(), inspected = [];
  const preparation = preparePlayback(playback, {}, {
    search: async () => [{ title: 'Preferred archive' }, { title: 'Slow lower rank' }],
    load: async release => {
      if (release.title === 'Slow lower rank') await tail;
      return nzb('rar');
    },
    health: { has: async () => false }, plans: createPlaybackPlanCache(),
    progressive: async job => { inspected.push(job.release); job.status = 'ready'; job.mode = 'direct'; return true; },
    archive: async () => { throw new Error('A progressive archive must not fall back to a full download.'); }
  });
  let timer;
  try {
    assert.equal(await Promise.race([
      preparation.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 100); })
    ]), true, 'a ready progressive archive must not wait for lower-ranked NZBs');
  } finally {
    clearTimeout(timer);
    releaseTail();
    await preparation;
  }
  assert.deepEqual(inspected, ['Preferred archive']);
  assert.equal(playback.release, 'Preferred archive');
});

test('speculative resume preparation does not extract a cold archive before play is clicked', async () => {
  const playback = { ...job(), speculative: true };
  let opened = false, downloaded = false;
  await preparePlayback(playback, {}, {
    search: async () => [{ title: 'Resumable archive' }],
    load: async () => nzb('rar'), health: { has: async () => false }, plans: createPlaybackPlanCache(),
    progressive: async candidate => { opened = true; candidate.status = 'ready'; candidate.mode = 'direct'; return true; },
    archive: async () => { downloaded = true; }
  });
  assert.equal(opened, false);
  assert.equal(downloaded, false);
  assert.equal(playback.status, 'error');
});

test('a failed progressive archive check keeps its volumes for a requested full download retry', async () => {
  const playback = job();
  await preparePlayback(playback, { usenetHost: 'provider.example' }, {
    search: async () => [{ title: 'Only archive' }],
    load: async () => nzb('rar'),
    check: async () => Buffer.from('archive'),
    health: { has: async () => false },
    plans: createPlaybackPlanCache(),
    progressive: async candidate => {
      candidate.status = 'ready';
      candidate.mode = 'direct';
      return true;
    },
    preflight: async () => { throw new Error('Progressive stream ended early.'); },
    archive: async () => { assert.fail('Full download requires an explicit retry.'); }
  });
  assert.equal(playback.status, 'error');
  assert.match(playback.message, /No replacement streaming archive/);
  assert.ok(playback.archives?.length, 'retry needs the selected archive volumes');
});

test('unsupported progressive archives retain the original ranked full-download fallback', async () => {
  const playback = job(), inspected = [], downloaded = [];
  await preparePlayback(playback, {}, {
    search: async () => [{ title: 'Preferred' }, { title: 'Other' }],
    load: async () => nzb('rar'), health: { has: async () => false }, plans: createPlaybackPlanCache(),
    progressive: async job => { inspected.push(job.release); return false; },
    archive: async job => { downloaded.push(job.release); job.status = 'ready'; }
  });
  assert.deepEqual(inspected, ['Preferred', 'Other']);
  assert.deepEqual(downloaded, ['Preferred']);
});

test('a downloaded release with an invalid media timeline is blacklisted before trying the next archive', async () => {
  const playback = job(), downloaded = [], rejected = [];
  await preparePlayback(playback, {}, {
    search: async () => [{ title: 'Broken timeline' }, { title: 'Healthy replacement' }],
    load: async () => nzb('rar'), health: {
      has: async () => false,
      reject: async (_settings, _media, release) => rejected.push(release)
    }, plans: createPlaybackPlanCache(), progressive: async () => false,
    archive: async job => {
      downloaded.push(job.release);
      if (job.release === 'Broken timeline') throw Object.assign(new Error('Video freezes while audio continues.'), { code: 'INVALID_MEDIA_TIMELINE' });
      job.status = 'ready'; job.mode = 'cached';
    }
  });
  assert.equal(playback.status, 'ready');
  assert.deepEqual(downloaded, ['Broken timeline', 'Healthy replacement']);
  assert.deepEqual(rejected, ['Broken timeline']);
});

test('background next-episode preparation accepts an archive release', async () => {
  const playback = { ...job(), prepareAhead: true, backgroundFor: 'current-playback' };
  const downloaded = [];
  await preparePlayback(playback, { backgroundJob: playback }, {
    search: async () => [{ title: 'Silo S01E02 archive' }],
    load: async () => nzb('rar'),
    health: { has: async () => false },
    plans: createPlaybackPlanCache(),
    archive: async job => { downloaded.push(job.release); job.status = 'ready'; job.mode = 'cached'; }
  });
  assert.equal(playback.status, 'ready', playback.message);
  assert.deepEqual(downloaded, ['Silo S01E02 archive']);
});

test('known unreadable archives are skipped without paying for a doomed full download', async () => {
  const playback = job(), downloaded = [];
  await preparePlayback(playback, {}, {
    search: async () => [{ title: 'Encrypted' }, { title: 'Supported by full extractor' }],
    load: async () => nzb('rar'), health: { has: async () => false }, plans: createPlaybackPlanCache(),
    progressive: async job => { if (job.release === 'Encrypted') throw Object.assign(new Error('Encrypted'), { code: 'ARCHIVE_UNAVAILABLE' }); return false; },
    archive: async job => { downloaded.push(job.release); job.status = 'ready'; }
  });
  assert.deepEqual(downloaded, ['Supported by full extractor']);
});

test('source recovery may use a progressive archive but never silently starts a full download', async () => {
  for (const available of [true, false]) {
    const playback = { ...job(), rejectedReleases: new Set(['Invalid direct source']) };
    let downloads = 0;
    await preparePlayback(playback, {}, {
      search: async () => [{ title: 'Replacement archive' }], load: async () => nzb('rar'),
      health: { has: async () => false }, plans: createPlaybackPlanCache(),
      progressive: async job => { if (available) { job.status = 'ready'; job.mode = 'direct'; } return available; },
      archive: async () => { downloads++; }
    });
    assert.equal(playback.status, available ? 'ready' : 'error');
    assert.equal(downloads, 0);
  }
});

test('playback can reach a valid result beyond the old 24-item parser cutoff', async () => {
  const { searchResults } = await import('../src/lib/server/streamer.js');
  const xml = '<rss>' + Array.from({ length: 40 }, (_, i) => `<item><title>Candidate ${i}</title><enclosure url="https://indexer.example/${i}" /></item>`).join('') + '</rss>';
  const playback = job();
  await preparePlayback(playback, {}, {
    search: async () => searchResults(xml),
    load: async release => { if (release.title !== 'Candidate 39') throw new Error('Missing'); return nzb('mp4'); },
    check: async () => Buffer.from('video'),
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.equal(playback.status, 'ready');
  assert.equal(playback.release, 'Candidate 39');
});

test('a failed upload does not blacklist another upload with the same release title', async () => {
  const releases=[{title:'Same release',nzbUrl:'https://indexer.example/get?id=bad'}, {title:'Same release',nzbUrl:'https://indexer.example/get?id=good'}];
  const rejected=new Set(), seen=[];
  const deps={
    search:async()=>releases,
    load:async release=>{seen.push(release.nzbUrl);if(release.nzbUrl.endsWith('bad'))throw Object.assign(new Error('Missing'),{code:'USENET_ARTICLE_MISSING'});return nzb('mp4');},
    check:async()=>Buffer.from('video'),
    health:{has:async(_s,_m,key)=>rejected.has(key),reject:async(_s,_m,key)=>rejected.add(key)},
    plans:createPlaybackPlanCache()
  };
  const first=job();await preparePlayback(first,{},deps);assert.equal(first.status,'ready');
  deps.plans=createPlaybackPlanCache();
  const second=job();await preparePlayback(second,{},deps);
  assert.equal(second.status,'ready');
  assert.equal(seen.filter(url=>url.endsWith('bad')).length,1);
  assert.equal(seen.filter(url=>url.endsWith('good')).length,2);
});
