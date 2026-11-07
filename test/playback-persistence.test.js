import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlaybackPersistence } from '../src/lib/server/playback-persistence.js';

test('release selections and validated metadata survive restart indefinitely while video bytes expire', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resume-cache-'));
  let time = Date.now();
  const options = { now: () => time }, settings = { usenetHost: 'provider', playbackQuality: 'quality', cacheRetentionHours: 1 };
  const media = { type: 'movie', id: 1 }, file = { subject: 'movie.mp4', segments: [{ id: 'one', decodedBytes: 4 }] };
  const torrentMedia = { type: 'movie', id: 2 };
  const torrentSource = { kind: 'torrent', version: 1, infoHash: 'a'.repeat(40), torrent: 'saved-metadata', file: { index: 0, path: 'movie.mp4', size: 100 } };
  try {
    const first = createPlaybackPersistence(root, options);
    await first.setPlan(media, settings, { file, release: 'One', strategy: 'raw', prefetchedSegments: new Map() });
    await first.setPlan(torrentMedia, settings, { torrentSource });
    await first.setProbe(file, settings, { audioIndex: 1, duration: 100 });
    first.setSegment(file, 0, settings, Buffer.from('ABCD')); await first.flush();
    const restarted = createPlaybackPersistence(root, options);
    const plan = await restarted.getPlan(media, settings);
    assert.equal(plan.release, 'One');
    assert.deepEqual(await restarted.getProbe(plan.file, settings), { audioIndex: 1, duration: 100 });
    assert.equal((await restarted.getSegment(plan.file, 0, settings)).toString(), 'ABCD');
    for (const changed of [{ playbackQuality: 'fast' }, { targetResolution: '2160p' }, { usenetPass: 'changed' }, { untaggedAudioTrack: 1 }, { indexerKey: 'changed' }, { manualReleaseSelection: true }, { repairVideoTimeline: true }]) {
      assert.equal(await restarted.getPlan(media, { ...settings, ...changed }), null);
      assert.equal(await restarted.getProbe(file, { ...settings, ...changed }), null);
    }
    time += 2 * 365 * 86400000;
    await restarted.prune(settings);
    const later = createPlaybackPersistence(root, options);
    assert.equal((await later.getPlan(media, settings)).release, 'One');
    assert.deepEqual(await later.getProbe(file, settings), { audioIndex: 1, duration: 100 });
    assert.deepEqual((await later.getPlan(torrentMedia, settings)).torrentSource, torrentSource);
    assert.equal(await later.getSegment(file, 0, settings), null);
    await later.deletePlan(torrentMedia);
    assert.equal(await createPlaybackPersistence(root, options).getPlan(torrentMedia, settings), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('disk bytes are globally bounded and corruption is a cache miss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resume-cache-'));
  const file = { subject: 'movie.mp4', segments: [{ id: 'one', decodedBytes: 4 }, { id: 'two', decodedBytes: 4 }] };
  const cache = createPlaybackPersistence(root, { maximumBytes: 36 });
  try {
    cache.setSegment(file, 0, {}, Buffer.from('ABCD')); await cache.flush();
    cache.setSegment(file, 1, {}, Buffer.from('EFGH')); await cache.flush();
    assert.equal(await cache.getSegment(file, 0, {}), null);
    assert.equal((await cache.getSegment(file, 1, {})).toString(), 'EFGH');
    const [name] = await readdir(join(root, 'articles'));
    await writeFile(join(root, 'articles', name), Buffer.alloc(36));
    assert.equal(await cache.getSegment(file, 1, {}), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('clearing one title removes its saved plan, probe and source bytes only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resume-cache-clear-'));
  const settings = { usenetHost: 'provider' };
  const firstMedia = { type: 'movie', id: 1 }, secondMedia = { type: 'tv', id: 2, season: 1, episode: 3 };
  const firstFile = { subject: 'first.mkv', segments: [{ id: 'one', decodedBytes: 4 }] };
  const secondFile = { subject: 'second.mkv', segments: [{ id: 'two', decodedBytes: 4 }] };
  const cache = createPlaybackPersistence(root);
  try {
    for (const [media, file, bytes] of [[firstMedia, firstFile, 'AAAA'], [secondMedia, secondFile, 'BBBB']]) {
      await cache.setPlan(media, settings, { file, release: file.subject, strategy: 'transcode' });
      await cache.setProbe(file, settings, { duration: 100 });
      cache.setSegment(file, 0, settings, Buffer.from(bytes));
    }
    const torrentSettings = { ...settings, torrentIndexerUrl: 'https://torrent.example/api' };
    await cache.setPlan(firstMedia, torrentSettings, { torrentSource: { kind: 'torrent', infoHash: 'b'.repeat(40) } });
    await cache.flush();
    assert.deepEqual(await cache.deleteMedia(firstMedia), { sources: 2 });
    assert.equal(await cache.getPlan(firstMedia, settings), null);
    assert.equal(await cache.getPlan(firstMedia, torrentSettings), null);
    assert.equal(await cache.getProbe(firstFile, settings), null);
    assert.equal(await cache.getSegment(firstFile, 0, settings), null);
    assert.equal((await cache.getSegment(secondFile, 0, settings)).toString(), 'BBBB');
    assert.equal((await cache.getPlan(secondMedia, settings)).release, 'second.mkv');
  } finally { await rm(root, { recursive: true, force: true }); }
});
