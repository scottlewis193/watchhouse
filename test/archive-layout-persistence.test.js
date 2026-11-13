import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPlaybackPersistence } from '../src/lib/server/playback-persistence.js';

const settings = { usenetHost: 'provider', usenetUser: 'user', usenetPass: 'secret', cacheRetentionHours: 1 };
const media = { type: 'movie', id: 123 };
const archives = [{ subject: 'video.part1.rar', segments: [{ id: 'one', number: 1, bytes: 120, decodedBytes: 100 }] }];
const layout = { name: 'video.mkv', size: 80, parts: [{ videoStart: 0, archiveStart: 20, length: 80, videoEnd: 80 }], volumeOffsets: [0, 100] };

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'archive-layout-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('archive layouts survive restart, isolate full scope and manifest, expire and delete without a plan', () => fixture(async root => {
  let time = 100;
  const options = { now: () => time };
  const cache = createPlaybackPersistence(root, options);
  await cache.setArchiveLayout(archives, settings, layout, media);
  const restarted = createPlaybackPersistence(root, options);
  assert.deepEqual(await restarted.getArchiveLayout(archives, settings), layout);
  for (const change of [{ usenetHost: 'other' }, { usenetPass: 'other' }, { usenetUser: 'other' }, { usenetPort: 119 }, { repairVideoTimeline: true }, { playbackQuality: 'quality' }, { indexerKey: 'other' }]) {
    assert.equal(await restarted.getArchiveLayout(archives, { ...settings, ...change }), null);
  }
  for (const changed of [
    [{ ...archives[0], subject: 'renamed.rar' }],
    [{ ...archives[0], segments: [{ ...archives[0].segments[0], id: 'other' }] }],
    [{ ...archives[0], segments: [{ ...archives[0].segments[0], number: 2 }] }],
    [{ ...archives[0], segments: [{ ...archives[0].segments[0], bytes: 121 }] }],
    [...archives, { ...archives[0], subject: 'part2.rar' }]
  ]) assert.equal(await restarted.getArchiveLayout(changed, settings), null);
  time += 3600000;
  assert.equal(await restarted.getArchiveLayout(archives, settings), null);
  await restarted.setArchiveLayout(archives, settings, layout, media);
  await restarted.deleteMedia(media);
  assert.equal(await createPlaybackPersistence(root, options).getArchiveLayout(archives, settings), null);
  await restarted.setArchiveLayout(archives, settings, layout, media);
  await restarted.deleteArchiveLayout(archives, settings);
  assert.equal(await restarted.getArchiveLayout(archives, settings), null);
}));

test('archive layout corruption and malformed mappings are cache misses', () => fixture(async root => {
  const cache = createPlaybackPersistence(root);
  for (const invalid of [{ ...layout, size: -1 }, { ...layout, parts: [] }, { ...layout, volumeOffsets: [0, 0] }, { ...layout, parts: [{ ...layout.parts[0], videoEnd: 79 }] }]) {
    await cache.setArchiveLayout(archives, settings, invalid, media);
    assert.equal(await cache.getArchiveLayout(archives, settings), null);
  }
  await cache.setArchiveLayout(archives, settings, layout, media);
  const path = join(root, 'records.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.records[0][1].value.layout.name = 'tampered.mkv';
  await writeFile(path, JSON.stringify(data));
  assert.equal(await createPlaybackPersistence(root).getArchiveLayout(archives, settings), null);
}));

test('archive layout bounds never evict verified metadata or direct and torrent plans', () => fixture(async root => {
  const cache = createPlaybackPersistence(root);
  await cache.setProbe(archives[0], settings, { duration: 42 });
  await cache.setPlan(media, settings, { file: archives[0], strategy: 'direct' });
  const torrentMedia = { type: 'movie', id: 456 };
  await cache.setPlan(torrentMedia, settings, { torrentSource: { infoHash: 'saved' } });
  for (let index = 0; index < 129; index++) await cache.setArchiveLayout([{ ...archives[0], subject: `part-${index}` }], settings, layout, media);
  assert.equal(await cache.getArchiveLayout([{ ...archives[0], subject: 'part-0' }], settings), null);
  assert.deepEqual(await cache.getArchiveLayout([{ ...archives[0], subject: 'part-128' }], settings), layout);
  assert.deepEqual(await cache.getProbe(archives[0], settings), { duration: 42 });
  assert.equal((await cache.getPlan(media, settings)).strategy, 'direct');
  assert.deepEqual((await cache.getPlan(torrentMedia, settings)).torrentSource, { infoHash: 'saved' });
}));
