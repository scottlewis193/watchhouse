import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMediaStateStore } from '../src/lib/server/media-state.js';

test('persists library membership and derives resumable media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picture-house-state-'));
  const path = join(directory, 'state.json');
  let timestamp = 100;
  const store = createMediaStateStore(path, { now: () => ++timestamp });
  const movie = { id: 10, type: 'movie', title: 'Film', year: '2025', poster: 'poster.jpg' };
  const episode = { id: 20, type: 'tv', title: 'Show', season: 1, episode: 2, episodeTitle: 'Second' };
  try {
    await store.setLibrary(movie, true);
    await store.setProgress(movie, { position: 300, duration: 1200 });
    await store.setProgress(episode, { position: 600, duration: 900 });
    const state = await store.read();
    assert.deepEqual(state.library.map(item => item.title), ['Film']);
    assert.deepEqual(state.continueWatching.map(item => [item.title, item.episode, Math.round(item.progressPercent)]), [['Show', 2, 67], ['Film', undefined, 25]]);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('keeps direct-stream progress resumable when the browser cannot report a reliable duration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picture-house-state-'));
  const store = createMediaStateStore(join(directory, 'state.json'));
  const movie = { id: 10, type: 'movie', title: 'Film' };
  try {
    const state = await store.setProgress(movie, { position: 45, duration: 0 });
    assert.equal(state.continueWatching.length, 1);
    assert.equal(state.continueWatching[0].position, 45);
    assert.equal(state.continueWatching[0].progressPercent, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('watched media leaves Continue Watching and marking unwatched resets it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picture-house-state-'));
  const store = createMediaStateStore(join(directory, 'state.json'));
  const episode = { id: 20, type: 'tv', title: 'Show', season: 1, episode: 2, episodeTitle: 'Second' };
  try {
    await store.setProgress(episode, { position: 600, duration: 900 });
    let state = await store.setProgress(episode, { watched: true });
    assert.equal(state.continueWatching.length, 0);
    assert.equal(state.progress[0].position, 900);
    state = await store.setProgress(episode, { watched: false, reset: true });
    assert.equal(state.progress[0].watched, false);
    assert.equal(state.progress[0].position, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('updates a whole episode collection atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchhouse-state-'));
  const store = createMediaStateStore(join(directory, 'state.json'));
  const episodes = [1, 2, 3].map(episode => ({ id: 20, type: 'tv', title: 'Show', season: 1, episode, episodeTitle: `Episode ${episode}` }));
  try {
    let state = await store.setProgressMany(episodes, { watched: true });
    assert.deepEqual(state.progress.map(entry => [entry.media.episode, entry.watched]).sort((a, b) => a[0] - b[0]), [[1, true], [2, true], [3, true]]);
    assert.equal(state.continueWatching.length, 0);
    state = await store.setProgressMany(episodes, { watched: false, reset: true });
    assert.deepEqual(state.progress.map(entry => [entry.media.episode, entry.position, entry.watched]).sort((a, b) => a[0] - b[0]), [[1, 0, false], [2, 0, false], [3, 0, false]]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
