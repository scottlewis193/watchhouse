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
  assert.deepEqual(started, ['Rank 0', 'Rank 1', 'Rank 2'], 'stop looking ahead once a playable release is selected');
});
