import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createPlaybackPersistence } from '../src/lib/server/playback-persistence.js';

const settings = { usenetHost: 'provider', usenetUser: 'user', usenetPass: 'private-password', cacheRetentionHours: 1 };
const media = { type: 'movie', id: 123 };
const archives = [
  { subject: 'video.part1.rar', segments: [{ id: 'one', number: 1, bytes: 120, decodedBytes: 100 }] },
  { subject: 'video.part2.rar', segments: [{ id: 'two', number: 1, bytes: 120, decodedBytes: 100 }] }
];
const layout = {
  name: 'video.mkv', size: 160, volumeOffsets: [0, 100, 200],
  parts: [
    { videoStart: 0, archiveStart: 20, length: 80, videoEnd: 80 },
    { videoStart: 80, archiveStart: 120, length: 80, videoEnd: 160 }
  ]
};
const metadata = {
  tracks: [{ index: 1, type: 'audio', language: 'eng', label: 'English', supported: true }],
  audioIndex: 1, videoIndex: 0, duration: 7200, videoFrameRate: 24, videoCodec: 'h264'
};

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'archive-probe-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function changeProbe(root, change) {
  const path = join(root, 'records.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  const entry = data.records.find(([key]) => key.startsWith('archive-probe:'));
  assert.ok(entry, 'the public setter must have saved a probe');
  change(entry[1].value);
  await writeFile(path, JSON.stringify(data));
}

test('stored archive metadata survives restart without packets, validation flags or credentials', () => fixture(async root => {
  const first = createPlaybackPersistence(root, { now: () => 100 });
  const input = { ...structuredClone(metadata), packets: [{ dts_time: '0' }], timelineValidated: true, decodeValidated: true, usenetPass: settings.usenetPass };
  input.tracks[0].packets = [{ stream_index: 1 }];
  await first.setArchiveProbe(archives, settings, layout, input, media);
  input.tracks[0].label = 'Mutated';
  const restarted = createPlaybackPersistence(root, { now: () => 100 });
  const saved = await restarted.getArchiveProbe(archives, settings, layout);
  assert.deepEqual(saved, metadata);
  saved.tracks[0].label = 'Changed again';
  assert.deepEqual(await restarted.getArchiveProbe(archives, settings, layout), metadata);
  assert.equal((await stat(join(root, 'records.json'))).mode & 0o777, 0o600);
  const contents = await readFile(join(root, 'records.json'), 'utf8');
  for (const forbidden of ['packets', 'timelineValidated', 'decodeValidated', settings.usenetPass]) assert.equal(contents.includes(forbidden), false);
}));

test('archive metadata identity includes ordered manifests, settings policy and every mapping field', () => fixture(async root => {
  const cache = createPlaybackPersistence(root, { now: () => 100 });
  await cache.setArchiveProbe(archives, settings, layout, metadata, media);
  for (const change of [
    { usenetHost: 'other' }, { usenetPort: 119 }, { usenetUser: 'other' }, { usenetPass: 'other' },
    { indexerUrl: 'other' }, { indexerKey: 'other' }, { playbackQuality: 'quality' }, { targetResolution: '2160p' },
    { untaggedAudioTrack: 1 }, { manualReleaseSelection: true }, { repairVideoTimeline: true }, { frameInterpolation: true }
  ]) assert.equal(await cache.getArchiveProbe(archives, { ...settings, ...change }, layout), null);
  for (const changed of [
    [...archives].reverse(),
    [{ ...archives[0], subject: 'other.rar' }, archives[1]],
    ...['id', 'number', 'bytes', 'decodedBytes'].map(field => [
      { ...archives[0], segments: [{ ...archives[0].segments[0], [field]: field === 'id' ? 'changed' : 2 }] }, archives[1]
    ]),
    [{ ...archives[0], segments: [...archives[0].segments, { id: 'extra', number: 2, bytes: 20, decodedBytes: 10 }] }, archives[1]]
  ]) assert.equal(await cache.getArchiveProbe(changed, settings, layout), null);
  for (const changed of [
    { ...layout, name: 'another.mkv' },
    { ...layout, size: 159, parts: [layout.parts[0], { ...layout.parts[1], length: 79, videoEnd: 159 }] },
    { ...layout, parts: [{ ...layout.parts[0], archiveStart: 19 }, layout.parts[1]] },
    { ...layout, volumeOffsets: [0, 101, 200] }
  ]) assert.equal(await cache.getArchiveProbe(archives, settings, changed), null);
  const splitArchives = [{ ...archives[0], segments: [
    { id: 'first', number: 1, bytes: 60, decodedBytes: 50 },
    { id: 'second', number: 2, bytes: 60, decodedBytes: 50 }
  ] }, archives[1]];
  await cache.setArchiveProbe(splitArchives, settings, layout, metadata, media);
  const reversedSegments = structuredClone(splitArchives);
  reversedSegments[0].segments.reverse();
  assert.equal(await cache.getArchiveProbe(reversedSegments, settings, layout), null);
  assert.deepEqual(await cache.getArchiveProbe(archives, settings, layout), metadata);
  await changeProbe(root, value => { value.version = 0; });
  assert.equal(await createPlaybackPersistence(root, { now: () => 100 }).getArchiveProbe(archives, settings, layout), null);
}));

test('pending, incomplete, malformed and non-stored mappings never admit metadata', () => fixture(async root => {
  const cache = createPlaybackPersistence(root);
  const invalidLayouts = [
    null, {}, { name: 'video.mkv', size: 160 },
    { ...layout, parts: [] },
    { ...layout, parts: [layout.parts[0]] },
    { ...layout, parts: [layout.parts[0], { ...layout.parts[1], videoStart: 81 }] },
    { ...layout, parts: [{ ...layout.parts[0], archiveStart: 0 }, layout.parts[1]] },
    { ...layout, parts: [{ ...layout.parts[0], archiveStart: 21 }, layout.parts[1]] },
    { ...layout, parts: [{ ...layout.parts[0], archiveStart: -1 }, layout.parts[1]] },
    { ...layout, parts: [{ ...layout.parts[0], length: 79 }, layout.parts[1]] },
    { ...layout, volumeOffsets: [0, 100] },
    { ...layout, volumeOffsets: [0, 0, 200] },
    { ...layout, volumeOffsets: [0, , 200] },
    { ...layout, volumeOffsets: [0, 100, Infinity] },
    { ...layout, size: 1 },
    { ...layout, name: '../video.mkv' },
    { ...layout, name: 'sample.mkv' },
    { ...layout, name: 'compressed.rar' }
  ];
  for (const invalid of invalidLayouts) {
    await cache.setArchiveProbe(archives, settings, invalid, metadata, media);
    assert.equal(await cache.getArchiveProbe(archives, settings, invalid), null);
    assert.equal(await cache.getArchiveProbe(archives, settings, layout), null);
  }
  await cache.setArchiveProbe(archives, settings, layout, metadata, media);
  for (const invalid of invalidLayouts) assert.equal(await cache.getArchiveProbe(archives, settings, invalid), null);
  assert.deepEqual(await cache.getArchiveProbe(archives, settings, layout), metadata);
}));

test('archive probes accept only finite typed metadata and preserve optional repair hints', () => fixture(async root => {
  const cache = createPlaybackPersistence(root);
  for (const change of [
    { tracks: null }, { tracks: [null] }, { tracks: [{ index: -1, type: 'audio' }] },
    { tracks: [{ index: 1, type: 'audio', language: [] }] },
    { audioIndex: -1 }, { audioIndex: 1.5 }, { audioIndex: undefined }, { videoIndex: null }, { videoIndex: -1 },
    { duration: NaN }, { duration: Infinity }, { duration: -1 }, { videoFrameRate: 0 }, { videoFrameRate: Infinity },
    { videoCodec: 1 }, { repairVideoFrameRate: null }, { repairVideoFrameRate: 0 }, { repairVideoFrameRate: Infinity }
  ]) {
    await cache.setArchiveProbe(archives, settings, layout, { ...metadata, ...change }, media);
    assert.equal(await cache.getArchiveProbe(archives, settings, layout), null);
  }
  const repaired = { ...metadata, tracks: [], audioIndex: null, duration: 0, videoFrameRate: null, videoCodec: null, repairVideoFrameRate: 24 };
  await cache.setArchiveProbe(archives, settings, layout, repaired, media);
  assert.deepEqual(await createPlaybackPersistence(root).getArchiveProbe(archives, settings, layout), repaired);
}));

test('corruption, format changes and malformed payloads are misses even after restarting', () => fixture(async root => {
  const options = { now: () => 100 };
  for (const tamper of [
    value => { value.metadata.duration = 1; },
    value => { value.checksum = 'bad-checksum'; },
    value => { value.version++; },
    value => { value.at = 200; },
    value => { value.expires = null; },
    value => { value.metadata = null; }
  ]) {
    await createPlaybackPersistence(root, options).setArchiveProbe(archives, settings, layout, metadata, media);
    await changeProbe(root, tamper);
    assert.equal(await createPlaybackPersistence(root, options).getArchiveProbe(archives, settings, layout), null);
  }
  await createPlaybackPersistence(root, options).setArchiveProbe(archives, settings, layout, metadata, media);
  const path = join(root, 'records.json'), data = JSON.parse(await readFile(path, 'utf8'));
  const [key, entry] = data.records.find(([key]) => key.startsWith('archive-probe:'));
  entry.value.metadata.videoIndex = -1;
  entry.value.checksum = createHash('sha256').update(JSON.stringify([key, entry.value.metadata])).digest('hex');
  await writeFile(path, JSON.stringify(data));
  assert.equal(await createPlaybackPersistence(root, options).getArchiveProbe(archives, settings, layout), null);
}));

test('archive probe retention expires exactly at the boundary and honours a shorter current policy', () => fixture(async root => {
  let time = 100;
  const options = { now: () => time }, longerRetention = { ...settings, cacheRetentionHours: 2 };
  const cache = createPlaybackPersistence(root, options);
  await cache.setArchiveProbe(archives, longerRetention, layout, metadata, media);
  time += 3600000 - 1;
  assert.deepEqual(await createPlaybackPersistence(root, options).getArchiveProbe(archives, settings, layout), metadata);
  time++;
  assert.equal(await createPlaybackPersistence(root, options).getArchiveProbe(archives, settings, layout), null);
  await cache.setArchiveProbe(archives, settings, layout, metadata, media);
  time += 3600000;
  assert.equal(await createPlaybackPersistence(root, options).getArchiveProbe(archives, settings, layout), null);
}));

test('failed archive invalidation clears all matching layouts but no unrelated metadata or plans', () => fixture(async root => {
  const cache = createPlaybackPersistence(root);
  const otherArchives = [{ ...archives[0], subject: 'other.part1.rar' }, archives[1]];
  const otherLayout = { ...layout, name: 'another.mkv' };
  const otherMedia = { type: 'movie', id: 456 };
  const otherSettings = { ...settings, playbackQuality: 'quality' };
  await cache.setArchiveLayout(archives, settings, layout, media);
  await cache.setArchiveProbe(archives, settings, layout, metadata, media);
  await cache.setArchiveProbe(archives, settings, otherLayout, metadata, media);
  await cache.setArchiveProbe(otherArchives, settings, layout, metadata, otherMedia);
  await cache.setArchiveProbe(archives, otherSettings, layout, metadata, media);
  await cache.setProbe(archives[0], settings, { duration: 42 });
  await cache.setPlan(media, settings, { file: archives[0], strategy: 'direct' });
  await cache.deleteArchiveLayout(archives, settings);
  const restarted = createPlaybackPersistence(root);
  assert.equal(await restarted.getArchiveLayout(archives, settings), null);
  assert.equal(await restarted.getArchiveProbe(archives, settings, layout), null);
  assert.equal(await restarted.getArchiveProbe(archives, settings, otherLayout), null);
  assert.deepEqual(await restarted.getArchiveProbe(otherArchives, settings, layout), metadata);
  assert.deepEqual(await restarted.getArchiveProbe(archives, otherSettings, layout), metadata);
  assert.deepEqual(await restarted.getProbe(archives[0], settings), { duration: 42 });
  assert.equal((await restarted.getPlan(media, settings)).strategy, 'direct');
}));

test('deleting media without a saved plan removes only its archive probes in every scope', () => fixture(async root => {
  const cache = createPlaybackPersistence(root), otherMedia = { type: 'movie', id: 456 };
  const otherArchives = [{ ...archives[0], subject: 'other.part1.rar' }, archives[1]];
  const otherSettings = { ...settings, playbackQuality: 'quality' };
  await cache.setArchiveProbe(archives, settings, layout, metadata, media);
  await cache.setArchiveProbe(archives, otherSettings, layout, metadata, media);
  await cache.setArchiveProbe(otherArchives, settings, layout, metadata, otherMedia);
  await cache.deleteMedia(media);
  const restarted = createPlaybackPersistence(root);
  assert.equal(await restarted.getArchiveProbe(archives, settings, layout), null);
  assert.equal(await restarted.getArchiveProbe(archives, otherSettings, layout), null);
  assert.deepEqual(await restarted.getArchiveProbe(otherArchives, settings, layout), metadata);
}));

test('archive probe count and expiry eviction leave layouts and other persistent metadata untouched', () => fixture(async root => {
  let time = 100;
  const cache = createPlaybackPersistence(root, { now: () => time });
  await cache.setArchiveLayout(archives, { ...settings, cacheRetentionHours: 2 }, layout, media);
  await cache.setProbe(archives[0], settings, { duration: 42 });
  await cache.setPlan(media, settings, { file: archives[0], strategy: 'direct' });
  for (let index = 0; index < 129; index++) {
    time++;
    await cache.setArchiveProbe([{ ...archives[0], subject: `part-${index}` }, archives[1]], settings, layout, metadata, media);
  }
  assert.equal(await cache.getArchiveProbe([{ ...archives[0], subject: 'part-0' }, archives[1]], settings, layout), null);
  assert.deepEqual(await cache.getArchiveProbe([{ ...archives[0], subject: 'part-1' }, archives[1]], settings, layout), metadata);
  assert.deepEqual(await cache.getArchiveProbe([{ ...archives[0], subject: 'part-128' }, archives[1]], settings, layout), metadata);
  time += 3600000;
  await cache.setArchiveProbe(archives, settings, layout, metadata, media);
  assert.equal(await cache.getArchiveProbe([{ ...archives[0], subject: 'part-128' }, archives[1]], settings, layout), null);
  assert.deepEqual(await cache.getArchiveProbe(archives, settings, layout), metadata);
  assert.deepEqual(await cache.getArchiveLayout(archives, { ...settings, cacheRetentionHours: 2 }), layout);
  assert.deepEqual(await cache.getProbe(archives[0], settings), { duration: 42 });
  assert.equal((await cache.getPlan(media, settings)).strategy, 'direct');
}));

test('a probe copied onto a different archive identity fails its checksum', () => fixture(async root => {
  const options = { now: () => 100 }, cache = createPlaybackPersistence(root, options);
  const otherLayout = { ...layout, name: 'another.mkv' };
  await cache.setArchiveProbe(archives, settings, layout, metadata, media);
  await cache.setArchiveProbe(archives, settings, otherLayout, { ...metadata, duration: 1 }, media);
  const path = join(root, 'records.json'), data = JSON.parse(await readFile(path, 'utf8'));
  const probes = data.records.filter(([key]) => key.startsWith('archive-probe:'));
  probes[1][1].value = structuredClone(probes[0][1].value);
  await writeFile(path, JSON.stringify(data));
  const restarted = createPlaybackPersistence(root, options);
  assert.deepEqual(await restarted.getArchiveProbe(archives, settings, layout), metadata);
  assert.equal(await restarted.getArchiveProbe(archives, settings, otherLayout), null);
}));
