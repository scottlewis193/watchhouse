import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import * as controls from '../src/lib/playback-controls.js';

const source = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const names = ['loadNextEpisode', 'warmNextEpisode', 'cancelNextPreparation', 'tickUpNextCountdown', 'playNextEpisode', 'cancelUpNext'];
const handlers = parse(source).instance.content.body
  .filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name))
  .map(node => source.slice(node.start, node.end)).join('\n');

function episodeState(reason) {
  const timers = new Map();
  let timerId = 0;
  const state = {
    ...controls, Date: { now: () => 40000 },
    nextMedia: { type: 'tv', id: 1, season: 1, episode: 2 },
    currentMedia: { type: 'tv', id: 1, season: 1, episode: 1 },
    nextPreparation: null,
    autoPlayNext: true, showUpNext: true, upNextStartedAt: 10000,
    upNextSeconds: 0, upNextReason: reason, upNextTimer: null,
    starts: [], setWatched() {},
    startPlayback: (...args) => { state.starts.push(args); },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id)
  };
  runInNewContext(handlers, state);
  return { state, timers };
}

test('the ordinary end countdown does not advance a stalled episode', () => {
  const { state } = episodeState('Episode ending');
  state.tickUpNextCountdown();
  assert.equal(state.starts.length, 0);
});

test('an elapsed credits countdown starts the next episode through foreground playback once', () => {
  const { state } = episodeState('End credits detected');
  state.tickUpNextCountdown();
  state.tickUpNextCountdown();
  assert.deepEqual(state.starts, [[state.nextMedia, false, true]]);
});

test('autoplay starts preparing the next episode with five minutes left', async () => {
  const { state } = episodeState('Episode ending');
  const candidate = state.nextMedia;
  const requests = [];
  Object.assign(state, {
    nextMedia: undefined, nextPreparation: null, playback: { id: 'current', status: 'ready' },
    playing: true, offlineMode: false, connectionLost: false, manualReleaseSelection: false,
    playbackRequests: { isCurrent: () => true },
    downloaded: () => ({ available: false }),
    itemKey: item => `${item.season}:${item.episode}`,
    adjacentEpisodeMedia: async () => candidate,
    api: { post: async (url, body) => { requests.push([url, body.nextFor, body.episode]); return { id: 'warm' }; } }
  });
  await state.loadNextEpisode(state.currentMedia, 1);
  state.warmNextEpisode({ position: 799, duration: 1100 });
  assert.deepEqual(requests, [], 'do not warm more than five minutes before the handoff');
  state.warmNextEpisode({ position: 800, duration: 1100 });
  assert.equal(requests.length, 1, 'warm at the five-minute boundary');
  state.warmNextEpisode({ position: 801, duration: 1100 });
  assert.deepEqual(requests, [['/api/play', 'current', 2]]);
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

test('cancelling the credits countdown prevents automatic playback', () => {
  const { state } = episodeState('End credits detected');
  state.cancelUpNext();
  state.tickUpNextCountdown();
  assert.equal(state.starts.length, 0);
});
