import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NntpClient, preparePlayback, createPlaybackPlanCache } from '../src/lib/server/streamer.js';

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
