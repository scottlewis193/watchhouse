import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import { canUseFallback, streamInterruptionAction, hasGrowingStreamDuration, shouldContinuePlayback, resumePosition, progressDuration, resolvedMediaDuration, playbackTimeline } from '../src/lib/playback-controls.js';

const source = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const ast = parse(source);
const names = ['handlePlaybackInterruption', 'offerPlaybackRecovery', 'fallback', 'showReadyPlayback', 'restorePlaybackProgress', 'attemptAutomaticPlayback', 'controlTimeline', 'handleEnded'];
const handlers = ast.instance.content.body.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name)).map(node => source.slice(node.start, node.end)).join('\n');

function recoveryState(retries = 0) {
  const requests = [], polls = [];
  const state = {
    playback: { id: 's02e03', status: 'ready', mode: 'direct', revision: 7 },
    currentMedia: { title: 'Friday Night Dinner', season: 2, episode: 3 },
    player: { currentTime: 12, duration: 1400, paused: true, play: async () => { state.plays++; } },
    plays: 0, automaticStreamRetries: retries, playbackDiagnostics: false,
    playbackRecovery: null, playbackNeedsAction: false, playbackSettled: true,
    continuePlaybackOnReady: false, playing: true, resumeStarting: false,
    resumeStreamOffset: 128, recoveryPosition: 0, resumePlayback: false,
    restoredMediaKey: 'episode', currentPlaybackRequestToken: 1,
    interruptionTimer: null, startupStableTimer: null, diagnosticPollTimer: null, fallbackPending: false,
    sourceDuration: 1400, clearTimeout() {}, setTimeout() { return 1; },
    canUseFallback, streamInterruptionAction, hasGrowingStreamDuration,
    shouldContinuePlayback, resumePosition, progressDuration, resolvedMediaDuration, playbackTimeline,
    captureVideoDiagnostics() {}, playerPosition: 12, playerDuration: 1400, seekPreview: null,
    currentPlaybackPosition: () => state.player.currentTime + state.resumeStreamOffset,
    savePlaybackProgress: async () => {}, stopBackgroundPlayback() {},
    settlePlaybackWarmup() {}, beginPlaybackWarmup() { state.playbackSettled = false; },
    progressFor: () => ({ position: 140, duration: 1400 }), itemKey: () => 'episode',
    tick: async () => {},
    playbackRequests: { begin: () => 2, isCurrent: token => token === 2 },
    api: { post: async url => { requests.push(url); return { id: 's02e03', status: 'downloading', mode: 'direct' }; } },
    poll: async (...args) => { polls.push(args); }, refreshDiagnostics() {},
    restartStream: position => { state.restartedAt = position; }
  };
  Object.assign(state, { seekPaused: false, seekTimer: null, buffering: false, statusFailures: 0, lastAdvancedPosition: 0, lastDiagnosticAt: 0, AbortSignal, playbackTrace: { event() {} } });
  runInNewContext(handlers, state);
  return { state, requests, polls };
}

for (const unavailable of [true, false]) test(unavailable
  ? 'an unavailable S02E03 source automatically prepares another release without a recovery prompt'
  : 'exhausted stream retries automatically download and resume without a recovery prompt', async () => {
  const { state, requests, polls } = recoveryState(unavailable ? 0 : 3);
  state.handlePlaybackInterruption('media-error', 'The selected release cannot continue.', unavailable ? { code: 'SOURCE_UNAVAILABLE' } : {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['/api/play/s02e03/fallback']);
  assert.equal(state.playbackRecovery, null, 'recovery must not wait for a button click');
  assert.equal(state.recoveryPosition, 140);
  assert.equal(polls.length, 1);
  assert.equal(state.continuePlaybackOnReady, true);
});

test('a recovered cached release restores the absolute playhead and starts automatically', async () => {
  const { state } = recoveryState();
  await state.fallback();
  const cached = { id: 's02e03', status: 'ready', mode: 'cached' };
  state.player.currentTime = 0;
  await state.showReadyPlayback(cached, 2);
  state.restorePlaybackProgress();
  assert.equal(state.player.currentTime, 140, 'the same episode key must not suppress recovery seeking');
  assert.equal(state.plays, 1, 'preparation must not require another click on Play');
});

test('ordinary interruptions retain bounded automatic direct-stream retries', () => {
  const { state, requests } = recoveryState();
  state.handlePlaybackInterruption('buffering-timeout', 'No progress');
  assert.equal(state.restartedAt, 140);
  assert.equal(state.automaticStreamRetries, 1);
  assert.equal(requests.length, 0);
});

test('duplicate media and HLS failures start only one fallback request', async () => {
  const { state, requests } = recoveryState();
  state.handlePlaybackInterruption('media-error', 'Invalid source', { code: 'SOURCE_UNAVAILABLE' });
  state.handlePlaybackInterruption('media-error', 'The same source failed again', { code: 'SOURCE_UNAVAILABLE' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(state.recoveryPosition, 140);
  state.handlePlaybackInterruption('media-error', 'Old player teardown error');
  assert.equal(state.playback.status, 'downloading', 'teardown must not interrupt replacement preparation');
});

test('switching episodes during recovery does not publish or play the old replacement', async () => {
  const { state } = recoveryState();
  let release;
  state.api.post = () => new Promise(resolve => { release = resolve; });
  const pending = state.fallback();
  await new Promise(resolve => setImmediate(resolve));
  state.playback = { id: 'new-episode', status: 'ready', mode: 'direct' };
  state.playbackRequests.isCurrent = () => false;
  release({ id: 's02e03', status: 'downloading', mode: 'direct' });
  await pending;
  assert.equal(state.playback.id, 'new-episode');
  assert.equal(state.plays, 0);
});

test('a prepared-file failure is terminal instead of repeatedly downloading replacements', () => {
  const { state, requests } = recoveryState();
  state.playback.mode = 'cached';
  state.handlePlaybackInterruption('media-error', 'Browser codec unsupported');
  assert.equal(state.playback.status, 'error');
  assert.equal(requests.length, 0);
});

test('repeated partial episode endings automatically reach preparation without user clicks', async () => {
  const { state, requests } = recoveryState();
  state.currentMedia = { type: 'tv', season: 2, episode: 5, durationHint: 1320 };
  state.sourceDuration = 71;
  state.playerPosition = state.playerDuration = state.player.currentTime = 71;
  state.resumeStreamOffset = 0;
  for (let attempt = 0; attempt < 4; attempt++) state.handleEnded();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(state.recoveryPosition, 71);
  assert.equal(state.continuePlaybackOnReady, true);
  assert.equal(state.playbackRecovery, null);
});
