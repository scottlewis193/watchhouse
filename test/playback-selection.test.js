import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseHealthStore } from '../src/lib/server/release-health.js';
import { NntpClient, preparePlayback, createPlaybackPlanCache, preflightLiveCandidate } from '../src/lib/server/streamer.js';
import { rankReleases } from '../media.js';
import { waitForPlayback } from '../src/lib/server/playback-notifications.js';
import { cancelDownloadJob } from '../src/lib/server/download-cancellation.js';

const media = { type: 'tv', id: 95480, title: 'Slow Horses', season: 1, episode: 2 };
const nzb = extension => `<nzb><file subject="episode.${extension}"><segments><segment number="1">article</segment></segments></file></nzb>`;
const job = () => ({ media, events: [], status: 'selecting' });

async function withTorrentIndexer(run, { onSearch } = {}) {
  const { default: WebTorrent } = await import('webtorrent');
  const seeder = new WebTorrent({ dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
  let server;
  try {
    const torrents = [];
    for (const name of ['First', 'Second']) {
      torrents.push(await new Promise(resolve => seeder.seed(Buffer.alloc(16384, torrents.length + 1), {
        name: `Slow.Horses.S01E02.${name}.mkv`, announce: []
      }, resolve)));
    }
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api') {
        onSearch?.();
        res.end(`<rss>${['First', 'Second'].map((name, index) => `<item><title>Slow.Horses.S01E02.1080p.x264.${name}</title><enclosure url="http://127.0.0.1:${server.address().port}/${index}"/></item>`).join('')}</rss>`);
      } else res.end(torrents[Number(url.pathname.slice(1))].torrentFile);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await run({ torrentIndexerUrl: `http://127.0.0.1:${server.address().port}/api` }, torrents);
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => seeder.destroy(resolve));
  }
}

test('torrent fallback rejects a slow source before exposing playback and selects the next release', async () => {
  await withTorrentIndexer(async settings => {
    const playback = job();
    await preparePlayback(playback, settings, {
      search: async () => [], plans: createPlaybackPlanCache(), persistence: null,
      preflight: async candidate => {
        assert.equal(candidate.status, 'selecting', 'torrent must not be ready before its speed check');
        if (candidate.release.endsWith('.First')) throw Object.assign(new Error('Too slow for playback.'), { code: 'PLAYBACK_TOO_SLOW' });
        return { sessionUrl: '/prepared/torrent' };
      }
    });
    assert.equal(playback.status, 'ready');
    assert.equal(playback.release, 'Slow.Horses.S01E02.1080p.x264.Second');
  });
});

test('torrent preflight deadline frees the failed session before accepting the next candidate', async () => {
  await withTorrentIndexer(async settings => {
    const playback = { ...job(), media: { ...media, id: 95481 } }, attempted = [];
    let failedClosed = false, failedSignal;
    await preparePlayback(playback, settings, {
      search: async () => [], plans: createPlaybackPlanCache(), persistence: null,
      preflight: async (candidate, candidateSettings, start, options) => {
        attempted.push(candidate.release);
        const first = candidate.release.endsWith('.First');
        if (!first) {
          assert.equal(failedClosed, true);
          assert.equal(failedSignal.aborted, true);
        }
        let elapsed = 0, position = 2;
        return preflightLiveCandidate(candidate, candidateSettings, start, {
          ...options, timeoutMs: first ? 20 : options.timeoutMs,
          sessionFactory: async () => ({
            read: async () => Buffer.from('#EXTINF:2.0,'),
            health: () => ({ position, completed: false }),
            close: async () => { if (first) failedClosed = true; }
          }),
          inspect: async (_directory, signal) => {
            if (first) { failedSignal = signal; return new Promise(() => {}); }
            return [{ codec_type: 'video', start_time: '0' }, { codec_type: 'audio', start_time: '0' }];
          },
          now: () => elapsed,
          wait: async ms => { elapsed += ms; position += ms / 1000 * 1.3; }
        });
      }
    });
    assert.equal(playback.status, 'ready');
    assert.deepEqual(attempted, ['Slow.Horses.S01E02.1080p.x264.First', 'Slow.Horses.S01E02.1080p.x264.Second']);
    assert.match(playback.preparedSession.playlistUrl, /index\.m3u8$/);
  });
});

test('torrent fallback remains unavailable when every source fails its speed check', async () => {
  await withTorrentIndexer(async settings => {
    const playback = job();
    await preparePlayback(playback, settings, {
      search: async () => [], plans: createPlaybackPlanCache(), persistence: null,
      preflight: async () => { throw Object.assign(new Error('Too slow for playback.'), { code: 'PLAYBACK_TOO_SLOW' }); }
    });
    assert.equal(playback.status, 'error');
    assert.equal(playback.preparedSession, undefined);
  });
});

test('metadata-only torrent preparation is rechecked before foreground reuse', async () => {
  await withTorrentIndexer(async settings => {
    const options = { search: async () => [], plans: createPlaybackPlanCache(), persistence: null };
    const background = { ...job(), speculative: true, prepareAhead: true };
    await preparePlayback(background, settings, {
      ...options, preflight: async () => { assert.fail('Background metadata lookup must not stream torrent payload.'); }
    });
    assert.equal(background.release, 'Slow.Horses.S01E02.1080p.x264.First');
    const foreground = job();
    await preparePlayback(foreground, settings, {
      ...options,
      preflight: async candidate => {
        if (candidate.release.endsWith('.First')) throw Object.assign(new Error('Cached torrent has become too slow.'), { code: 'PLAYBACK_TOO_SLOW' });
        return { sessionUrl: '/prepared/replacement' };
      }
    });
    assert.equal(foreground.status, 'ready');
    assert.equal(foreground.release, 'Slow.Horses.S01E02.1080p.x264.Second');
  });
});

test('cached torrent validation and fallback search share one selection deadline', { timeout: 10000 }, async t => {
  let foreground = false;
  await withTorrentIndexer(async settings => {
    const options = { search: async () => [], plans: createPlaybackPlanCache(), persistence: null };
    const requested = { ...media, id: 95482 };
    await preparePlayback({ ...job(), media: requested, speculative: true, prepareAhead: true }, settings, options);
    const playback = { ...job(), media: requested }, attempted = [];
    foreground = true;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await preparePlayback(playback, settings, {
        ...options,
        preflight: async (candidate, { signal }) => {
          attempted.push(candidate.release);
          if (candidate.release.endsWith('.First')) {
            t.mock.timers.tick(30000);
            throw new Error('Cached source is no longer playable.');
          }
          signal.throwIfAborted();
          return { sessionUrl: '/prepared/replacement' };
        }
      });
      assert.equal(playback.status, 'error');
      assert.match(playback.message, /torrent selection timed out/i);
      assert.deepEqual(attempted, ['Slow.Horses.S01E02.1080p.x264.First']);
      assert.equal(playback.preparedSession, undefined);
    } finally { t.mock.timers.reset(); }
  }, { onSearch: () => { if (foreground) t.mock.timers.tick(60000); } });
});

for (const playable of [true, false]) test(`torrent source recovery ${playable ? 'selects an alternative' : 'reports exhausted alternatives'} without repeating Usenet`, async () => {
  await withTorrentIndexer(async (settings, torrents) => {
    const playback = { ...job(), media: { ...media, id: playable ? 95483 : 95484 },
      torrentSource: { infoHash: torrents[0].infoHash }, selectionStart: 117.5,
      rejectedReleases: new Set([`torrent:${torrents[0].infoHash}`]) };
    let usenetSearches = 0;
    await preparePlayback(playback, settings, {
      torrentOnly: true, plans: createPlaybackPlanCache(), persistence: null,
      search: async () => { usenetSearches++; return []; },
      preflight: async (candidate, _settings, start) => {
        assert.equal(candidate.release, 'Slow.Horses.S01E02.1080p.x264.Second');
        assert.equal(start, 117.5);
        if (!playable) throw new Error('The remaining torrent cannot sustain playback.');
        return { sessionUrl: '/prepared/replacement', start };
      }
    });
    assert.equal(usenetSearches, 0);
    assert.equal(playback.status, playable ? 'ready' : 'error');
    if (playable) assert.equal(playback.preparedSession.start, 117.5);
    else assert.equal(playback.preparedSession, undefined);
  });
});

test('cancelling torrent admission stops selection without trying another swarm', async () => {
  await withTorrentIndexer(async settings => {
    const playback = job();
    const attempted = [];
    await preparePlayback(playback, settings, {
      search: async () => [], plans: createPlaybackPlanCache(), persistence: null,
      preflight: async (candidate, { signal }) => {
        attempted.push(candidate.release);
        cancelDownloadJob(playback);
        signal.throwIfAborted();
      }
    });
    assert.equal(playback.status, 'cancelled');
    assert.deepEqual(attempted, ['Slow.Horses.S01E02.1080p.x264.First']);
    assert.equal(playback.preparedSession, undefined);
  });
});

test('archive readiness notifications do not expose playback before preflight completes', async () => {
  const playback = job();
  let observed, notification, releaseCheck, pendingRevision;
  const checked = new Promise(resolve => { releaseCheck = resolve; });
  playback.archiveSource = {
    metadata: { get name() {
      notification ||= waitForPlayback(playback, playback.revision).then(() => { observed = playback.status; });
      return 'episode.mkv';
    }, size: 1024 },
    randomAccess: true,
    close: async () => {}
  };
  const preparation = preparePlayback(playback, { usenetHost: 'provider.example' }, {
    search: async () => [{ title: 'Playable archive' }], load: async () => nzb('rar'),
    check: async () => Buffer.from('archive'), health: { has: async () => false },
    plans: createPlaybackPlanCache(), persistence: null,
    preflight: async () => { await checked; return { sessionUrl: '/validated' }; }
  });
  try {
    for (let i = 0; i < 50 && !notification; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(notification, 'the real progressive archive opening must publish a notification');
    await notification;
    assert.equal(observed, 'selecting', 'a status subscriber must not start HLS or fallback during preflight');
    pendingRevision = playback.revision;
  } finally { releaseCheck(); await preparation; }
  assert.equal(playback.status, 'ready');
  assert.equal(playback.preparedSession.sessionUrl, '/validated');
  assert.ok(playback.revision > pendingRevision, 'validated readiness must wake subscribers even with diagnostics disabled');
});

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

test('resume prewarming retains the preferred streamable archive and validates it without a full download', async () => {
  const playback = { ...job(), speculative: true, selectionStart: 120 }, checked = [];
  await preparePlayback(playback, { usenetHost: 'fixture', playbackQuality: 'quality' }, {
    search: async () => [{ title: 'Film.2160p.Archive' }, { title: 'Film.1080p.Direct' }],
    load: async release => nzb(release.title.includes('Archive') ? 'rar' : 'mkv'),
    check: async () => Buffer.from('video'),
    progressive: async candidate => {
      candidate.progressiveArchive = true;
      candidate.archiveSource = { metadata: { size: 100 }, closed: false };
      candidate.file = { subject: 'film.mkv' };
      candidate.strategy = 'transcode';
      return true;
    },
    preflight: async (candidate, _settings, start) => { checked.push([candidate.release, start]); return { sessionUrl: '/prepared/archive', start }; },
    archive: async () => assert.fail('Speculative preparation must not download the archive'),
    cache: async () => assert.fail('Speculative preparation must not download a full video'),
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.equal(playback.status, 'ready');
  assert.equal(playback.release, 'Film.2160p.Archive');
  assert.deepEqual(checked, [['Film.2160p.Archive', 120]]);
});

test('unsupported speculative archives wait for foreground without changing quality or downloading', async () => {
  const playback = { ...job(), speculative: true }, loaded = [];
  await preparePlayback(playback, { usenetHost: 'fixture' }, {
    search: async () => [{ title: 'Film.2160p.Archive' }, { title: 'Film.1080p.Direct' }],
    load: async release => { loaded.push(release.title); return nzb('rar'); },
    progressive: async () => false,
    archive: async () => assert.fail('Speculative preparation must not download an archive'),
    cache: async () => assert.fail('Speculative preparation must not download a full video'),
    health: { has: async () => false }, plans: createPlaybackPlanCache()
  });
  assert.equal(playback.status, 'error');
  assert.deepEqual(loaded, ['Film.2160p.Archive']);
});

test('reposted missing article sets are checked once even when descriptions arrive concurrently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-articles-'));
  const releases = ['Broken', 'Repost', 'Healthy'].map(name => ({
    title: `Slow.Horses.S01E02.1080p.${name}`, nzbUrl: `https://indexer.example/${name}`
  }));
  const settings = { usenetHost: 'fixture' }, checked = [];
  const path = join(directory, 'health.json');
  try {
    for (const restart of [false, true]) {
      const playback = job();
      await preparePlayback(playback, settings, {
        search: async () => restart ? [releases[1], releases[2]] : releases,
        load: async release => release === releases[2] ? nzb('mkv').replace('>article<', '>healthy<')
          : `<nzb><file subject="${release.title}.mkv"><segments><segment number="1">missing</segment><segment number="2">tail</segment></segments></file></nzb>`,
        check: async file => {
          checked.push(file.segments[0].id);
          await new Promise(resolve => setImmediate(resolve));
          if (file.segments[0].id === 'missing') throw Object.assign(new Error('No such article'), { code: 'USENET_ARTICLE_MISSING' });
          return Buffer.from('video');
        },
        preflight: async () => ({ sessionUrl: '/prepared/healthy' }),
        health: createReleaseHealthStore(path), plans: createPlaybackPlanCache()
      });
      assert.equal(playback.status, 'ready');
      assert.equal(playback.release, releases[2].title);
    }
    assert.deepEqual(checked, ['missing', 'healthy', 'healthy']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('archive reposts with renamed and reordered volumes skip confirmed missing article sets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-archives-'));
  const releases = ['Broken', 'Repost', 'Healthy'].map(name => ({ title: `Film.1080p.${name}`, nzbUrl: `https://indexer.example/${name}` }));
  const attempted = [], playback = job();
  try {
    await preparePlayback(playback, { usenetHost: 'fixture' }, {
      search: async () => releases,
      load: async release => {
        const ids = release === releases[2] ? ['healthy-one', 'healthy-two'] : ['shared-one', 'shared-two'];
        if (release === releases[1]) ids.reverse();
        return `<nzb>${ids.map((id, index) => `<file subject="${release.title}.part0${index + 1}.rar"><segments><segment number="1">${id}</segment></segments></file>`).join('')}</nzb>`;
      },
      progressive: async candidate => {
        attempted.push(candidate.release);
        if (candidate.release === releases[0].title) throw Object.assign(new Error('Missing archive article'), { code: 'ARCHIVE_UNAVAILABLE', unavailableCode: 'USENET_ARTICLE_MISSING' });
        candidate.progressiveArchive = true;
        candidate.archiveSource = { metadata: { size: 100 }, closed: false };
        candidate.file = { subject: 'film.mkv' };
        candidate.strategy = 'remux';
        return true;
      },
      preflight: async () => ({ sessionUrl: '/prepared/archive' }),
      archivePlans: { get: () => null, delete: () => {} },
      health: createReleaseHealthStore(join(directory, 'health.json')), plans: createPlaybackPlanCache()
    });
    assert.equal(playback.status, 'ready');
    assert.equal(playback.release, releases[2].title);
    assert.deepEqual(attempted, [releases[0].title, releases[2].title]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('temporary or invalid-body failures do not poison another upload with the same articles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'article-failure-scope-'));
  try {
    for (const code of ['ETIMEDOUT', 'INVALID_USENET_ARTICLE']) {
      const playback = job(), checked = [];
      const releases = ['First', 'Replacement'].map(name => ({ title: `Film.1080p.${name}`, nzbUrl: `https://indexer.example/${name}` }));
      await preparePlayback(playback, { usenetHost: 'fixture' }, {
        search: async () => releases,
        load: async () => nzb('mkv'),
        check: async () => {
          checked.push(code);
          if (checked.length === 1) throw Object.assign(new Error('First attempt failed'), { code });
          return Buffer.from('video');
        },
        preflight: async () => ({ sessionUrl: '/prepared/replacement' }),
        health: createReleaseHealthStore(join(directory, `${code}.json`)), plans: createPlaybackPlanCache()
      });
      assert.equal(playback.status, 'ready');
      assert.equal(playback.release, releases[1].title);
      assert.deepEqual(checked, [code, code]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
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

test('size tiers defer NZB and provider work until earlier tiers fail, retaining oversized playback fallback', async () => {
  const settings = { playbackQuality: 'fast', targetResolution: '2160p' };
  const candidates = [
    { title: 'Slow.Horses.S01E02.2160p.H264.Large.mkv', size: 8 * 1024 ** 3 },
    { title: 'Slow.Horses.S01E02.2160p.H264.Unknown.mkv', size: 0 },
    { title: 'Slow.Horses.S01E02.1080p.H264.Small.mkv', size: 1024 ** 3 }
  ];
  const order = [candidates[2], candidates[1], candidates[0]];
  for (let chosen = 0; chosen < order.length; chosen++) {
    const playback = job(), loaded = [], checked = [];
    await preparePlayback(playback, settings, {
      search: async () => rankReleases(candidates, media, settings),
      load: async release => {
        loaded.push(release.title);
        return nzb('mkv').replace('episode.mkv', release.title);
      },
      check: async file => { checked.push(file.subject); return Buffer.from('video'); },
      preflight: async candidate => {
        if (candidate.release !== order[chosen].title) throw Object.assign(new Error('too slow'), { code: 'PLAYBACK_TOO_SLOW' });
        return { sessionUrl: '/prepared/video' };
      },
      health: { has: async () => false }, plans: createPlaybackPlanCache()
    });
    assert.equal(playback.status, 'ready');
    assert.equal(playback.release, order[chosen].title);
    assert.deepEqual(loaded, order.slice(0, chosen + 1).map(release => release.title));
    assert.deepEqual(checked, loaded);
  }
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

test('repeated missing archives defer their resolution without dropping healthy archive fallbacks', async () => {
  const missing = Array.from({ length: 12 }, (_, index) => ({ title: `Film.1080p.MissingArchive${index}`, size: 1024 ** 3 }));
  for (const [lowerPlayable, oversizedLower] of [[true, false], [false, false], [true, true]]) {
    const lower = { title: 'Film.720p.Direct', size: (oversizedLower ? 8 : 1) * 1024 ** 3 };
    const healthy = { title: 'Film.1080p.HealthyArchive', size: 1024 ** 3 };
    const playback = { ...job(), diagnosticsEnabled: true }, loaded = [], probed = [];
    await preparePlayback(playback, { usenetHost: 'fixture' }, {
      search: async () => oversizedLower ? [...missing, healthy, lower] : [...missing, lower, healthy],
      load: async release => { loaded.push(release.title); return nzb(release === lower ? 'mkv' : 'rar'); },
      check: async () => Buffer.from('video'),
      progressive: async candidate => {
        probed.push(candidate.release);
        if (candidate.release !== healthy.title) {
          throw Object.assign(new Error('Missing archive article'), { code: 'ARCHIVE_UNAVAILABLE', unavailableCode: 'USENET_ARTICLE_MISSING' });
        }
        candidate.progressiveArchive = true;
        candidate.archiveSource = { metadata: { size: 100 }, closed: false };
        candidate.file = { subject: 'film.mkv' };
        candidate.strategy = 'remux';
        return true;
      },
      preflight: async candidate => {
        if (candidate.release === lower.title && !lowerPlayable) throw Object.assign(new Error('too slow'), { code: 'PLAYBACK_TOO_SLOW' });
        return { sessionUrl: '/prepared/video' };
      },
      archivePlans: { get: () => null, delete: () => {} },
      health: { has: async () => false, reject: async () => {} }, plans: createPlaybackPlanCache()
    });
    assert.equal(playback.status, 'ready');
    const choseLower = lowerPlayable && !oversizedLower;
    assert.equal(playback.release, choseLower ? lower.title : healthy.title);
    if (choseLower) assert.ok(!loaded.includes(healthy.title), 'deferred NZBs must not compete with a viable lower resolution');
    else assert.ok(probed.includes(healthy.title), 'four missing uploads must not permanently exclude a healthy archive');
  }
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
    load: async release => nzb('mp4').replace('episode.mp4', `${release.title}.mp4`).replace('>article<', `>${release.title}<`),
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

test('a selected lower-resolution direct source is retained for resume under the same preset', async () => {
  const settings = { targetResolution: '2160p', playbackQuality: 'fast' };
  const plans = createPlaybackPlanCache(), starts = [];
  let searches = 0;
  for (const start of [0, 30]) {
    const playback = { ...job(), selectionStart: start };
    await preparePlayback(playback, settings, {
      plans, persistence: null, health: { has: async () => false },
      search: async () => { searches++; return [{ title: 'Film.1080p.SDR' }]; },
      load: async () => nzb('mkv'), check: async () => Buffer.from('video'),
      preflight: async (_candidate, _settings, offset) => { starts.push(offset); return { start: offset }; }
    });
    assert.equal(playback.status, 'ready');
    assert.equal(playback.release, 'Film.1080p.SDR');
    assert.equal(playback.preparedSession.start, start);
  }
  assert.equal(searches, 1, 'the accepted fallback must not trigger a fresh release search on resume');
  assert.deepEqual(starts, [0, 30]);
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


test('a failed progressive archive check downloads a copy during initial playback', async () => {
  const playback = job();
  let downloads = 0;
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
    archive: async candidate => { downloads++; candidate.status = 'ready'; candidate.mode = 'cached-convert'; }
  });
  assert.equal(playback.status, 'ready');
  assert.equal(playback.mode, 'cached-convert');
  assert.equal(downloads, 1);
});

test('an archive article missing during preflight never triggers a full download', async () => {
  const playback = job();
  let downloads = 0;
  await preparePlayback(playback, { usenetHost: 'provider.example' }, {
    search: async () => [{ title: 'Only archive' }], load: async () => nzb('rar'),
    check: async () => Buffer.from('archive'), health: { has: async () => false, reject: async () => {} },
    plans: createPlaybackPlanCache(),
    progressive: async candidate => { candidate.status = 'ready'; candidate.mode = 'direct'; return true; },
    preflight: async () => { throw Object.assign(new Error('Required archive article is missing.'), { code: 'USENET_ARTICLE_MISSING' }); },
    archive: async () => { downloads++; }
  });
  assert.equal(downloads, 0, 'downloading cannot restore a missing article');
  assert.equal(playback.status, 'error');
  assert.match(playback.message, /missing/);
});

test('an explicitly chosen archive downloads after its progressive opening fails', async () => {
  const release = { title: 'Attack.on.Titan.S01E17.1080p.BluRay.x265-ImE', category: 'TV > Anime' };
  const playback = { ...job(), manualRelease: release };
  const events = [];
  await preparePlayback(playback, { usenetHost: 'provider.example' }, {
    search: async () => assert.fail('Manual release must not search'),
    load: async () => nzb('rar'), check: async () => Buffer.from('archive'),
    health: { has: async () => false }, plans: createPlaybackPlanCache(),
    progressive: async candidate => { candidate.status = 'ready'; candidate.mode = 'direct'; return true; },
    preflight: async () => { throw new Error('Progressive stream ended early.'); },
    archive: async candidate => { events.push('download'); candidate.status = 'ready'; candidate.mode = 'cached-convert'; }
  });
  assert.deepEqual(events, ['download']);
  assert.equal(playback.status, 'ready');
  assert.equal(playback.mode, 'cached-convert');
  assert.equal(playback.events.some(event => event.activity === 'error'), false);
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
