import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlaybackPersistence } from '../src/lib/server/playback-persistence.js';

test('plans, validated metadata and source bytes survive restart with expiry and settings isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resume-cache-'));
  let time = Date.now();
  const options = { now: () => time }, settings = { usenetHost: 'provider', playbackQuality: 'quality', cacheRetentionHours: 1 };
  const media = { type: 'movie', id: 1 }, file = { subject: 'movie.mp4', segments: [{ id: 'one', decodedBytes: 4 }] };
  try {
    const first = createPlaybackPersistence(root, options);
    await first.setPlan(media, settings, { file, release: 'One', strategy: 'raw', prefetchedSegments: new Map() });
    await first.setProbe(file, settings, { audioIndex: 1, duration: 100 });
    first.setSegment(file, 0, settings, Buffer.from('ABCD')); await first.flush();
    const restarted = createPlaybackPersistence(root, options);
    const plan = await restarted.getPlan(media, settings);
    assert.equal(plan.release, 'One');
    assert.deepEqual(await restarted.getProbe(plan.file, settings), { audioIndex: 1, duration: 100 });
    assert.equal((await restarted.getSegment(plan.file, 0, settings)).toString(), 'ABCD');
    for (const changed of [{ playbackQuality: 'fast' }, { usenetPass: 'changed' }, { untaggedAudioTrack: 1 }, { indexerKey: 'changed' }, { manualReleaseSelection: true }]) {
      assert.equal(await restarted.getPlan(media, { ...settings, ...changed }), null);
      assert.equal(await restarted.getProbe(file, { ...settings, ...changed }), null);
    }
    time += 3600001;
    assert.equal(await restarted.getPlan(media, settings), null);
    assert.equal(await restarted.getSegment(file, 0, settings), null);
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
