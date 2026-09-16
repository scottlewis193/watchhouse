import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import * as controls from '../src/lib/playback-controls.js';

const source = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const names = ['beginUpNextCountdown', 'tickUpNextCountdown', 'playNextEpisode', 'pollNextEpisode', 'cancelUpNext'];
const handlers = parse(source).instance.content.body
  .filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name))
  .map(node => source.slice(node.start, node.end)).join('\n');

function episodeState(status = 'preparing') {
  const timers = new Map();
  let timerId = 0;
  const state = {
    ...controls, Date: { now: () => 40000 },
    nextMedia: { type: 'tv', id: 1, season: 1, episode: 2 },
    currentMedia: { type: 'tv', id: 1, season: 1, episode: 1 },
    nextJob: { id: 'next', status }, downloadNextEpisode: false,
    autoPlayNext: true, showUpNext: true, upNextStartedAt: 10000,
    upNextSeconds: 0, upNextReason: 'Episode finished',
    upNextTimer: null, nextPollTimer: null,
    playbackRequests: { isCurrent: () => true },
    starts: [], setWatched() {},
    startPlayback: (...args) => { state.starts.push(args); },
    api: { get: async () => ({ id: 'next', status: 'error' }) },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id)
  };
  runInNewContext(handlers, state);
  return { state, timers };
}

test('an elapsed countdown retries a failed next episode instead of waiting forever', () => {
  const { state } = episodeState('error');
  state.tickUpNextCountdown();
  assert.equal(state.starts.length, 1, 'the next episode must start after its preparation fails');
  assert.equal(state.starts[0][1], null, 'retry through normal foreground preparation');
  assert.equal(state.starts[0][3], true, 'retain autoplay intent');
});

test('preparation failing after the episode ends still advances', async () => {
  const { state, timers } = episodeState();
  state.tickUpNextCountdown();
  assert.equal(state.starts.length, 0);
  await state.pollNextEpisode('next', 1);
  for (const callback of [...timers.values()]) callback();
  assert.equal(state.starts.length, 1);
});

function playerLifetime(node, state, ancestors = []) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Element' && node.name === 'video') {
    return ancestors.filter(parent => parent.type === 'IfBlock' || parent.type === 'KeyBlock')
      .map(parent => ({ type: parent.type, value: runInNewContext(source.slice(parent.expression.start, parent.expression.end), state) }));
  }
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      const result = playerLifetime(child, state, [...ancestors, node]);
      if (result) return result;
    }
  }
  return null;
}

test('episode handover preserves the video element through foreground preparation and retry reset', () => {
  const ast = parse(source);
  const state = { playback: { status: 'ready' }, currentMedia: { type: 'tv' }, player: {}, streamAttempt: 2 };
  const before = playerLifetime(ast.html, state);
  assert.ok(before.every(parent => parent.type !== 'IfBlock' || Boolean(parent.value)));
  state.playback = { status: 'selecting' };
  state.streamAttempt = 0;
  const during = playerLifetime(ast.html, state);
  assert.ok(during.every(parent => parent.type !== 'IfBlock' || Boolean(parent.value)), 'preparation must not unmount the video that the user already allowed to play');
  assert.deepEqual(during.filter(parent => parent.type === 'KeyBlock'), before.filter(parent => parent.type === 'KeyBlock'), 'resetting retries must not create a new video');
});

for (const status of ['ready', 'cancelled']) test(`an elapsed countdown advances a ${status} next episode`, () => {
  const { state } = episodeState(status);
  state.tickUpNextCountdown();
  assert.equal(state.starts.length, 1);
  assert.equal(state.starts[0][1], status === 'ready' ? state.nextJob : null);
});

test('cancelling the countdown prevents a later ready poll from advancing', async () => {
  const { state } = episodeState();
  state.api.get = async () => ({ id: 'next', status: 'ready' });
  state.cancelUpNext();
  await state.pollNextEpisode('next', 1);
  state.tickUpNextCountdown();
  assert.equal(state.starts.length, 0);
});

test('a failed polling request does not strand an elapsed countdown', async () => {
  const { state } = episodeState();
  state.api.get = async () => { throw new Error('Network unavailable'); };
  await state.pollNextEpisode('next', 1);
  state.tickUpNextCountdown();
  assert.equal(state.starts.length, 1);
});
