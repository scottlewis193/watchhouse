import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveArticlesAvailable, NntpClient, preparePlayback, createPlaybackPlanCache } from '../src/lib/server/streamer.js';
import { createReleaseHints } from '../src/lib/server/release-hints.js';
import { EventEmitter } from 'node:events';

const media = { type: 'movie', id: 1, title: 'Film', year: '2024' };
const releases = ['Preferred', 'Missing', 'Healthy'].map(name => ({ title: `Film.2024.1080p.${name}` }));
const nzb = release => `<nzb><file subject="film.rar"><segments><segment number="1">${release.title}</segment></segments></file></nzb>`;

test('archive availability overlaps the active source without extracting alternatives or opening confirmed-missing archives', async () => {
  let releasePreferred, sawMissing, sawPreferred;
  const blocked = new Promise(resolve => { releasePreferred = resolve; });
  const missingChecked = new Promise(resolve => { sawMissing = resolve; });
  const preferredOpened = new Promise(resolve => { sawPreferred = resolve; });
  const opened = [], checked = [], playback = { media, events: [], status: 'selecting' };
  const preparation = preparePlayback(playback, { maxConnections: 4 }, {
    search: async () => releases, load: async release => nzb(release),
    archiveCheck: async archives => {
      const id = archives[0].segments[0].id;
      checked.push(id);
      if (id.endsWith('.Missing')) { sawMissing(); throw Object.assign(new Error('Missing article'), { code: 'USENET_ARTICLE_MISSING' }); }
    },
    progressive: async candidate => {
      opened.push(candidate.release);
      if (candidate.release.endsWith('.Preferred')) {
        sawPreferred();
        await blocked;
        throw Object.assign(new Error('Preferred archive is unavailable'), { code: 'ARCHIVE_UNAVAILABLE', unavailableCode: 'USENET_ARTICLE_MISSING' });
      }
      candidate.status = 'ready';
      return true;
    },
    health: { has: async () => false, reject: async () => {} }, plans: createPlaybackPlanCache()
  });
  let timer;
  try {
    assert.equal(await Promise.race([Promise.all([missingChecked, preferredOpened]).then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]), true);
    assert.deepEqual([...opened], [releases[0].title]);
  } finally { clearTimeout(timer); releasePreferred(); await preparation; }
  assert.equal(playback.status, 'ready');
  assert.equal(playback.release, releases[2].title);
  assert.deepEqual(opened, [releases[0].title, releases[2].title]);
  assert.deepEqual(checked, releases.map(release => release.title));
});

test('archive probes sample required endpoints and the middle, releasing their reader on a missing article', async () => {
  const archives = Array.from({ length: 3 }, (_, index) => ({
    subject: `film.part0${index + 1}.rar`, segments: [{ id: `${index}-first` }, { id: `${index}-last` }]
  }));
  const checked = [];
  let closed = 0;
  const connect = async () => ({ has: async id => { checked.push(id); return id !== '1-first'; }, close: () => closed++ });
  await assert.rejects(archiveArticlesAvailable(archives, {}, connect), { code: 'USENET_ARTICLE_MISSING' });
  assert.deepEqual(checked, ['0-first', '1-first']);
  assert.equal(closed, 1);
  checked.length = 0;
  assert.equal(await archiveArticlesAvailable(archives, {}, async () => ({ has: async id => { checked.push(id); return true; }, close: () => closed++ })), true);
  assert.deepEqual(checked, ['0-first', '1-first', '2-first', '2-last']);
  assert.equal(closed, 2);
});

test('STAT distinguishes missing articles from provider command failures', async () => {
  for (const status of ['223 article exists', '430 no article', '503 unavailable', '480 authentication required']) {
    const socket = new EventEmitter();
    socket.write = () => queueMicrotask(() => socket.emit('data', Buffer.from(`${status}\r\n`)));
    const client = new NntpClient(socket);
    if (status.startsWith('223')) assert.equal(await client.has('article'), true);
    else if (status.startsWith('430')) assert.equal(await client.has('article'), false);
    else await assert.rejects(client.has('article'), error => error.code !== 'USENET_ARTICLE_MISSING');
  }
});

test('archive probe cancellation closes an active reader', async () => {
  const controller = new AbortController();
  let closed = false, started;
  const reading = new Promise(resolve => { started = resolve; });
  const probe = archiveArticlesAvailable([{ subject: 'film.rar', segments: [{ id: 'one' }] }], { signal: controller.signal }, async settings => ({
    has: () => new Promise((resolve, reject) => { settings.signal.addEventListener('abort', () => reject(settings.signal.reason), { once: true }); started(); }),
    close: () => { closed = true; }
  }));
  await reading;
  controller.abort(new Error('Viewer left'));
  await assert.rejects(probe, /Viewer left/);
  assert.equal(closed, true);
});

test('inconclusive archive probes retain ordinary opening rather than rejecting a valid release', async () => {
  const playback = { media, events: [] };
  await preparePlayback(playback, { maxConnections: 4 }, {
    search: async () => [releases[0]], load: async release => nzb(release),
    archiveCheck: async () => { throw Object.assign(new Error('Temporary failure'), { code: 'ETIMEDOUT' }); },
    progressive: async candidate => { candidate.status = 'ready'; return true; },
    health: { has: async () => false, reject: async () => assert.fail('An inconclusive STAT must not blacklist an upload') }, plans: createPlaybackPlanCache()
  });
  assert.equal(playback.status, 'ready');
  assert.equal(playback.release, releases[0].title);
});

test('a recent existence hint skips only STAT, never archive opening or playback validation', async () => {
  const hints = createReleaseHints();
  let stats = 0, opened = 0, validated = 0;
  const settings = { usenetHost: 'provider', maxConnections: 4 };
  for (let index = 0; index < 4; index++) {
    const playback = { media, events: [] };
    await preparePlayback(playback, index === 2 ? { ...settings, usenetHost: 'other-provider' } : settings, {
      hints, search: async () => [releases[0]], load: async release => nzb(release),
      archiveCheck: async () => { stats++; return true; },
      progressive: async candidate => {
        opened++;
        if (index === 3) throw Object.assign(new Error('The body is now missing'), { code: 'ARCHIVE_UNAVAILABLE', unavailableCode: 'USENET_ARTICLE_MISSING' });
        candidate.progressiveArchive = true;
        return true;
      },
      preflight: async () => { validated++; return { sessionUrl: '/prepared/archive' }; },
      health: { has: async () => false, reject: async () => {} }, plans: createPlaybackPlanCache(), archivePlans: { get: () => null, delete: () => {} }
    });
    assert.equal(playback.status, index === 3 ? 'error' : 'ready');
  }
  assert.equal(stats, 2);
  assert.equal(opened, 4);
  assert.equal(validated, 3);
});
