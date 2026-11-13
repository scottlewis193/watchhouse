import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPlaybackPersistence } from '../src/lib/server/playback-persistence.js';

const settings = { usenetHost: 'provider', usenetUser: 'user', usenetPass: 'secret', cacheRetentionHours: 1 };
const media = { type: 'tv', id: 123, season: 1, episode: 2 };
const archives = [{ subject: 'video.part1.rar', segments: [{ id: 'one', number: 1, bytes: 120, decodedBytes: 100 }] }];
const plan = { archives, release: 'Video release', releaseKey: 'release-123', strategy: 'remux' };

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'archive-plan-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('successful archive manifests survive restart without retaining live source objects', () => fixture(async root => {
  const cache = createPlaybackPersistence(root);
  const source = { close() {} };
  source.socket = source;
  await cache.setPlan(media, settings, { ...plan, archiveSource: source, archiveHeader: { bytes: Buffer.from('header') }, file: { subject: 'video.mkv' } });
  const restarted = createPlaybackPersistence(root);
  const saved = await restarted.getPlan(media, settings);
  assert.deepEqual(saved, plan);
  saved.archives[0].segments[0].id = 'mutated';
  assert.deepEqual(await restarted.getPlan(media, settings), plan);
  assert.equal(await restarted.getPlan({ ...media, episode: 3 }, settings), null);
  assert.equal(await restarted.getPlan({ ...media, season: 2 }, settings), null);
  for (const change of [
    { usenetHost: 'other' }, { usenetUser: 'other' }, { usenetPass: 'other' }, { usenetPort: 119 },
    { indexerUrl: 'other' }, { indexerKey: 'other' }, { playbackQuality: 'quality' }, { targetResolution: '2160p' },
    { untaggedAudioTrack: 1 }, { repairVideoTimeline: true }, { frameInterpolation: true }, { manualReleaseSelection: true }
  ]) assert.equal(await restarted.getPlan(media, { ...settings, ...change }), null);
}));

test('archive plan retention expires at the boundary and respects a shortened current policy', () => fixture(async root => {
  let time = 100;
  const options = { now: () => time }, cache = createPlaybackPersistence(root, options);
  await cache.setPlan(media, settings, plan);
  time += 3600000 - 1;
  assert.deepEqual(await createPlaybackPersistence(root, options).getPlan(media, settings), plan);
  time++;
  assert.equal(await createPlaybackPersistence(root, options).getPlan(media, settings), null);
  const longer = { ...settings, cacheRetentionHours: 24 };
  await cache.setPlan(media, longer, plan);
  time += 3600000;
  assert.equal(await createPlaybackPersistence(root, options).getPlan(media, settings), null);
}));

test('invalid archive manifests never become reusable plans', () => fixture(async root => {
  const cache = createPlaybackPersistence(root);
  const withSegment = segment => [{ ...archives[0], segments: [segment] }];
  for (const invalid of [
    { archives: null }, { archives: [] }, { archives: new Array(4097).fill(archives[0]) },
    { archives: [{ ...archives[0], segments: new Array(1000001) }] },
    { archives: [null] }, { archives: [{ subject: '', segments: archives[0].segments }] },
    { archives: [{ ...archives[0], segments: [] }] }, { archives: withSegment(null) },
    ...['', 'bad\r\nQUIT', 'bad id', '<bad', 'x'.repeat(1025)].map(id => ({ archives: withSegment({ ...archives[0].segments[0], id }) })),
    ...[0, -1, Infinity, NaN, '1'].map(number => ({ archives: withSegment({ ...archives[0].segments[0], number }) })),
    ...['bytes', 'decodedBytes'].flatMap(field => [0, -1, Infinity, NaN, '100', Number.MAX_SAFE_INTEGER + 1].map(value => ({
      archives: withSegment({ ...archives[0].segments[0], [field]: value })
    }))),
    { archives: [{ ...archives[0], segments: [archives[0].segments[0], { ...archives[0].segments[0], number: 2 }] }] },
    { archives: [{ ...archives[0], segments: [archives[0].segments[0], { ...archives[0].segments[0], id: 'two' }] }] },
    { release: '' }, { releaseKey: {} }, { strategy: 'unknown' }
  ]) {
    await cache.setPlan(media, settings, { ...plan, ...invalid });
    assert.equal(await cache.getPlan(media, settings), null);
  }
  const minimal = { archives: [{ subject: 'video.rar', segments: [{ id: 'only', number: 1 }] }], release: plan.release, strategy: 'remux' };
  await cache.setPlan(media, settings, minimal);
  assert.deepEqual(await createPlaybackPersistence(root).getPlan(media, settings), minimal);
}));

test('corrupt archive records are discarded on restart before provider work', () => fixture(async root => {
  const path = join(root, 'records.json');
  for (const corrupt of [
    value => { value.manifest.archives[0].segments[0].id = 'different'; },
    value => { value.manifest.archives[0].segments[0].bytes = null; },
    value => { value.manifest.archives = []; },
    value => { delete value.manifest.archives; },
    value => { value.archivePlanVersion++; },
    value => { value.at = Date.now() + 86400000; },
    value => { value.expires = null; },
    value => { delete value.checksum; }
  ]) {
    await createPlaybackPersistence(root).setPlan(media, settings, plan);
    const data = JSON.parse(await readFile(path, 'utf8'));
    corrupt(data.records[0][1].value);
    await writeFile(path, JSON.stringify(data));
    assert.equal(await createPlaybackPersistence(root).getPlan(media, settings), null);
    assert.equal(await createPlaybackPersistence(root).getPlan(media, settings), null);
  }
}));

test('archive plan bounds do not evict direct or torrent plans and expired records make room', () => fixture(async root => {
  let time = 100;
  const options = { now: () => time }, cache = createPlaybackPersistence(root, options);
  const directMedia = { type: 'movie', id: 1 }, torrentMedia = { type: 'movie', id: 2 };
  const direct = { file: archives[0], release: 'Direct', strategy: 'raw' }, torrent = { torrentSource: { infoHash: 'saved' } };
  await cache.setPlan(directMedia, settings, direct);
  await cache.setPlan(torrentMedia, settings, torrent);
  for (let episode = 1; episode <= 129; episode++) {
    time++;
    await cache.setPlan({ ...media, episode }, settings, plan);
  }
  const restarted = createPlaybackPersistence(root, options);
  assert.equal(await restarted.getPlan({ ...media, episode: 1 }, settings), null);
  assert.deepEqual(await restarted.getPlan({ ...media, episode: 2 }, settings), plan);
  assert.deepEqual(await restarted.getPlan({ ...media, episode: 129 }, settings), plan);
  time += 3600000;
  await restarted.setPlan(media, settings, plan);
  assert.equal(await createPlaybackPersistence(root, options).getPlan({ ...media, episode: 129 }, settings), null);
  assert.deepEqual(await restarted.getPlan(directMedia, settings), direct);
  assert.deepEqual(await restarted.getPlan(torrentMedia, settings), torrent);
}));

test('deleting archive plans or media clears every saved policy without deleting other episodes', () => fixture(async root => {
  const otherMedia = { ...media, episode: 3 }, otherSettings = { ...settings, playbackQuality: 'quality' };
  const cache = createPlaybackPersistence(root);
  await cache.setPlan(media, settings, plan);
  await cache.setPlan(media, otherSettings, plan);
  await cache.setPlan(otherMedia, settings, plan);
  await cache.deletePlan(media);
  let restarted = createPlaybackPersistence(root);
  assert.equal(await restarted.getPlan(media, settings), null);
  assert.equal(await restarted.getPlan(media, otherSettings), null);
  assert.deepEqual(await restarted.getPlan(otherMedia, settings), plan);
  await restarted.setPlan(media, settings, plan);
  await restarted.setPlan(media, otherSettings, plan);
  assert.deepEqual(await restarted.deleteMedia(media), { sources: 2 });
  restarted = createPlaybackPersistence(root);
  assert.equal(await restarted.getPlan(media, settings), null);
  assert.equal(await restarted.getPlan(media, otherSettings), null);
  assert.deepEqual(await restarted.getPlan(otherMedia, settings), plan);
}));

test('archive manifests retain valid bracketed provider IDs and torrent plans keep their existing precedence', () => fixture(async root => {
  const cache = createPlaybackPersistence(root);
  const bracketed = { ...plan, archives: [{ ...archives[0], segments: [{ ...archives[0].segments[0], id: '<one@example>' }] }] };
  await cache.setPlan(media, settings, bracketed);
  assert.deepEqual(await createPlaybackPersistence(root).getPlan(media, settings), bracketed);
  const torrentSource = { infoHash: 'saved' };
  await cache.setPlan(media, settings, { ...plan, torrentSource });
  assert.deepEqual(await createPlaybackPersistence(root).getPlan(media, settings), { torrentSource });
}));
