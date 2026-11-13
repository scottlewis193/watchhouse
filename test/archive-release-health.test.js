import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReleaseHealthStore } from '../src/lib/server/release-health.js';

const settings = { usenetHost: 'provider', usenetUser: 'private-user', usenetPass: 'private-password' };
const media = { type: 'tv', id: 987654, season: 1, episode: 2 };

test('confirmed archive rejection reasons persist with credential and exact-media isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-health-'));
  try {
    let time = 100;
    const options = { now: () => time, ttl: 100, maximum: 3 };
    const path = join(root, 'health.json');
    const store = createReleaseHealthStore(path, options);
    await store.reject(settings, media, 'upload:private-id', 'ARCHIVE_ENCRYPTED');
    const restarted = createReleaseHealthStore(path, options);
    assert.deepEqual(await restarted.get(settings, media, 'upload:private-id'), { reason: 'ARCHIVE_ENCRYPTED', expires: 200 });
    for (const changed of [{ usenetPass: 'changed' }, { usenetUser: 'changed' }, { usenetHost: 'changed' }, { usenetPort: 119 }, { repairVideoTimeline: true }]) {
      assert.equal(await restarted.get({ ...settings, ...changed }, media, 'upload:private-id'), null);
    }
    assert.equal(await restarted.get(settings, { ...media, episode: 3 }, 'upload:private-id'), null);
    assert.equal(await restarted.get(settings, media, 'upload:other'), null);
    await restarted.reject(settings, media, 'upload:private-id');
    assert.equal((await restarted.get(settings, media, 'upload:private-id')).reason, 'ARCHIVE_ENCRYPTED');
    await restarted.reject(settings, media, 'articles:private-id', 'ARCHIVE_UNSUPPORTED');
    assert.equal((await restarted.get(settings, media, 'articles:private-id')).reason, 'ARCHIVE_UNSUPPORTED');
    await restarted.reject(settings, media, 'transient', 'ECONNRESET');
    assert.deepEqual(await restarted.get(settings, media, 'transient'), { reason: undefined, expires: 200 });
    const serialized = await readFile(path, 'utf8');
    for (const secret of ['private-user', 'private-password', 'private-id', '987654']) assert.equal(serialized.includes(secret), false);
    time = 200;
    assert.equal(await restarted.get(settings, media, 'upload:private-id'), null);
    assert.equal(await restarted.has(settings, media, 'upload:private-id'), false);
    await restarted.reject(settings, media, 'upload:private-id');
    assert.equal((await restarted.get(settings, media, 'upload:private-id')).reason, undefined);
    await restarted.delete(media);
    assert.equal(await createReleaseHealthStore(path, options).get(settings, media, 'upload:private-id'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cooldown count bounds retain only newest entries and malformed storage is ignored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-health-bound-'));
  try {
    const path = join(root, 'health.json');
    await writeFile(path, '{"unexpected":true}');
    const store = createReleaseHealthStore(path, { maximum: 2 });
    assert.equal(await store.get(settings, media, 'one'), null);
    for (const release of ['one', 'two', 'three']) await store.reject(settings, media, release, 'ARCHIVE_ENCRYPTED');
    assert.equal(await store.has(settings, media, 'one'), false);
    assert.equal(await store.has(settings, media, 'two'), true);
    assert.equal(await store.has(settings, media, 'three'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
