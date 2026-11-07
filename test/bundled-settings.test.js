import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSettingsStore } from '../src/lib/server/settings-store.js';
import { publicSettings } from '../src/lib/server/streamer.js';

async function fixture(t, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'watchhouse-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'settings.json');
  const bundledPath = join(directory, 'bundled-torznab.json');
  await writeFile(bundledPath, JSON.stringify({
    torrentIndexerUrl: 'http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab/api',
    torrentIndexerKey: 'private-bundled-key', indexers: ['limetorrents', 'nyaasi']
  }));
  const runtime = { WATCHHOUSE_BUNDLED_TORZNAB_FILE: bundledPath, ...env };
  return { path, bundledPath, runtime, store: createSettingsStore(path, { env: runtime }) };
}

test('bundled Torznab becomes the effective fallback without disclosing its credentials', async t => {
  const { store } = await fixture(t);
  const settings = await store.read();
  assert.equal(settings.torrentIndexerUrl, 'http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab/api');
  assert.equal(settings.torrentIndexerKey, 'private-bundled-key');
  const visible = publicSettings(settings);
  assert.deepEqual(visible.bundledTorrent, { enabled: true, available: true, active: true, indexers: ['limetorrents', 'nyaasi'] });
  assert.equal(visible.hasTorrentIndexer, true);
  assert.equal(visible.torrentIndexerUrl, '');
  assert.equal(visible.hasTorrentIndexerKey, false);
  assert.equal(JSON.stringify(visible).includes('private-bundled-key'), false);
  assert.equal(JSON.stringify(visible).includes('127.0.0.1:9117'), false);
});


test('saving unrelated settings never copies bundled credentials or metadata into settings.json', async t => {
  const { store, path } = await fixture(t);
  await store.update({ tmdbToken: 'catalogue-secret', indexerKey: 'usenet-indexer-secret', usenetPass: 'provider-secret', manualReleaseSelection: true });
  await store.update({ ...publicSettings(await store.read()), playbackQuality: 'fast', tmdbToken: '', indexerKey: '', usenetPass: '' });
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.tmdbToken, 'catalogue-secret');
  assert.equal(saved.indexerKey, 'usenet-indexer-secret');
  assert.equal(saved.usenetPass, 'provider-secret');
  assert.equal(saved.manualReleaseSelection, true);
  assert.equal(saved.playbackQuality, 'fast');
  for (const key of ['torrentIndexerUrl', 'torrentIndexerKey', 'bundledTorrent', 'hasTorrentIndexer', 'hasTorrentIndexerKey']) assert.equal(Object.hasOwn(saved, key), false);
  assert.equal((await store.read()).torrentIndexerKey, 'private-bundled-key');
});

test('clearing the external URL restores bundled mode and removes the old external key', async t => {
  const { store, path } = await fixture(t);
  await store.update({ torrentIndexerUrl: 'https://external.example/api', torrentIndexerKey: 'external-key' });
  const kept = await store.update({ torrentIndexerUrl: 'https://external.example/api', torrentIndexerKey: '', prepareSeries: false });
  assert.equal(kept.torrentIndexerKey, 'external-key');
  const restored = await store.update({ torrentIndexerUrl: '', torrentIndexerKey: '' });
  assert.equal(restored.torrentIndexerKey, 'private-bundled-key');
  assert.equal(restored.bundledTorrent.active, true);
  assert.equal(restored.prepareSeries, false);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { prepareSeries: false });
  const changed = await store.update({ torrentIndexerUrl: 'https://new.example/api', torrentIndexerKey: '' });
  assert.equal(changed.torrentIndexerKey, '');
  assert.equal(publicSettings(changed).hasTorrentIndexerKey, false);
});

test('changing external providers without a new key never reuses either previous provider key', async t => {
  const { store } = await fixture(t);
  await store.update({ torrentIndexerUrl: 'https://old.example/api', torrentIndexerKey: 'old-external-key' });
  const changed = await store.update({ torrentIndexerUrl: 'https://new.example/api', torrentIndexerKey: '' });
  assert.equal(changed.torrentIndexerKey, '');
  assert.equal(changed.bundledTorrent.active, false);
  assert.equal(publicSettings(changed).hasTorrentIndexerKey, false);
});

test('reset clears only saved settings and restores the runtime fallback', async t => {
  const { store, path, bundledPath } = await fixture(t);
  await store.update({ torrentIndexerUrl: 'https://external.example/api', torrentIndexerKey: 'external-key', tmdbToken: 'saved-token' });
  const reset = await store.reset();
  assert.equal(reset.bundledTorrent.active, true);
  assert.equal(reset.torrentIndexerKey, 'private-bundled-key');
  assert.equal(publicSettings(reset).hasTmdbToken, false);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {});
  assert.equal(JSON.parse(await readFile(bundledPath, 'utf8')).torrentIndexerKey, 'private-bundled-key');
});

test('runtime opt-out ignores an existing generated file while preserving explicit external configuration', async t => {
  const { store, runtime } = await fixture(t);
  assert.equal((await store.read()).bundledTorrent.active, true);
  runtime.WATCHHOUSE_BUNDLED_INDEXER = 'false';
  assert.deepEqual(await store.read(), {});
  const external = await store.update({ torrentIndexerUrl: 'https://external.example/api', torrentIndexerKey: 'external-key' });
  assert.equal(external.torrentIndexerUrl, 'https://external.example/api');
  assert.equal(external.torrentIndexerKey, 'external-key');
  assert.equal(external.bundledTorrent, undefined);
  await store.update({ torrentIndexerUrl: '' });
  assert.deepEqual(await store.read(), {});
});

test('source development without runtime configuration keeps the existing settings behavior', async t => {
  const { path } = await fixture(t);
  const store = createSettingsStore(path, { env: {} });
  assert.deepEqual(await store.read(), {});
  await store.update({ usenetHost: 'provider.example', usenetPass: 'saved-secret', manualReleaseSelection: true, prepareSeries: false });
  assert.deepEqual(await store.update({ usenetPass: '', maxConnections: '8' }), {
    usenetHost: 'provider.example', usenetPass: 'saved-secret', manualReleaseSelection: true, prepareSeries: false, maxConnections: '8'
  });
  assert.deepEqual(await store.reset(), {});
});

test('a missing generated file stays degraded until runtime publishes the ready configuration', async t => {
  const { store, bundledPath } = await fixture(t);
  const generated = await readFile(bundledPath, 'utf8');
  await rm(bundledPath);
  const missing = publicSettings(await store.read());
  assert.deepEqual(missing.bundledTorrent, { enabled: true, available: false, active: false, indexers: [] });
  assert.equal(missing.hasTorrentIndexer, false);
  await writeFile(bundledPath, generated);
  assert.equal((await store.read()).bundledTorrent.active, true);
});
