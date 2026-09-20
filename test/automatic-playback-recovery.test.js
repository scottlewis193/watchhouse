import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import { readPlaybackSetup } from '../src/lib/playback-setup.js';
import { bufferedRecoveryTarget, canUseFallback, streamInterruptionAction, hasGrowingStreamDuration, shouldContinuePlayback, resumePosition, progressDuration, resolvedMediaDuration, playbackTimeline } from '../src/lib/playback-controls.js';

const source = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const ast = parse(source);
const names = ['handlePlaybackInterruption', 'offerPlaybackRecovery', 'fallback', 'showReadyPlayback', 'restorePlaybackProgress', 'attemptAutomaticPlayback', 'controlTimeline', 'handleEnded'];
const handlers = ast.instance.content.body.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name)).map(node => source.slice(node.start, node.end)).join('\n');
const restartHandler = ast.instance.content.body.filter(node => node.type === 'FunctionDeclaration' && node.id.name === 'restartStream').map(node => source.slice(node.start, node.end)).join('\n');

function recoveryState(retries = 0) {
  const requests = [], polls = [];
  const state = {
    playback: { id: 's02e03', status: 'ready', mode: 'direct', revision: 7 },
    currentMedia: { title: 'Friday Night Dinner', season: 2, episode: 3 },
    player: { currentTime: 12, duration: 1400, paused: true, play: async () => { state.plays++; } },
    plays: 0, automaticStreamRetries: retries, playbackDiagnostics: false,
    playbackRecovery: null, playbackNeedsAction: false, playbackSettled: true, pendingBufferedRecovery: null, preparedSession: null,
    continuePlaybackOnReady: false, playing: true, resumeStarting: false,
    resumeStreamOffset: 128, recoveryPosition: 0, resumePlayback: false,
    restoredMediaKey: 'episode', currentPlaybackRequestToken: 1,
    interruptionTimer: null, startupStableTimer: null, diagnosticPollTimer: null, fallbackPending: false,
    sourceDuration: 1400, clearTimeout() {}, setTimeout() { return 1; },
    canUseFallback, streamInterruptionAction, hasGrowingStreamDuration, bufferedRecoveryTarget,
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
    restartStream: position => { state.restartedAt = position; },
    prepareBufferedSourceRecovery: () => { state.preparingReplacement = true; }, clearBufferedSourceRecovery() {}
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

test('an exhausted HLS preparation uses a downloaded copy instead of restarting extraction', async () => {
  const { state, requests } = recoveryState();
  state.handlePlaybackInterruption('media-error', 'Timed out preparing playback segments.', { code: 'PLAYBACK_SEGMENT_TIMEOUT' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['/api/play/s02e03/fallback']);
});

test('a rejected source prepares a replacement while the buffered video remains active', () => {
  const { state, requests } = recoveryState(3);
  state.handlePlaybackInterruption('hls-error', 'The source failed', { code: 'SOURCE_REJECTED' });
  assert.equal(state.preparingReplacement, true);
  assert.equal(state.restartedAt, undefined);
  assert.equal(requests.length, 0);
});

test('a buffered recovery target stays just inside the playable range', () => {
  const ranges = { length: 1, start: () => 5, end: () => 30 };
  assert.equal(bufferedRecoveryTarget(ranges, 12, 100), 129);
  assert.equal(bufferedRecoveryTarget(ranges, 29, 100), null);
  assert.equal(bufferedRecoveryTarget(ranges, 4, 100), null);
});

test('a ready replacement waits for the buffered edge before handing playback over', async () => {
  const names = ['clearBufferedSourceRecovery', 'completeBufferedSourceRecovery', 'prepareBufferedSourceRecovery'];
  const code = ast.instance.content.body.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name)).map(node => source.slice(node.start, node.end)).join('\n');
  const requests = []; let tick;
  const state = {
    playback: { id: 'movie', hlsUrl: '/api/play/movie/hls' },
    player: { currentTime: 12, paused: false, buffered: { length: 1, start: () => 0, end: () => 30 } },
    resumeStreamOffset: 100, streamAttempt: 0, pendingBufferedRecovery: null, buffering: false,
    bufferedRecoveryTarget, readPlaybackSetup, AbortSignal, AbortController,
    playbackTrace: { event() {} }, interpolationDisabled: false,
    currentPlaybackPosition: () => state.player.currentTime + 100,
    setInterval: callback => { tick = callback; return 1; }, clearInterval() {},
    fetch: async url => { requests.push(url); return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ sessionUrl: '/prepared', playlistUrl: '/prepared/index.m3u8' }) }; },
    restartStream: (position, session) => { state.handoff = { position, session }; },
    fallback() { assert.fail('The replacement is ready'); }, handlePlaybackInterruption() {}
  };
  runInNewContext(code, state);
  state.prepareBufferedSourceRecovery();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.handoff, undefined, 'the old buffered source must keep playing');
  assert.deepEqual(requests, ['/api/play/movie/hls']);
  state.player.currentTime = 29.1;
  tick();
  assert.equal(state.handoff.position, 129);
  assert.equal(state.handoff.session.sessionUrl, '/prepared');
  assert.equal(requests.includes('/prepared/stop'), false, 'handoff retains the prepared session');
});

test('replacement preparation failure leaves buffered playback running until it is exhausted', async () => {
  const names = ['clearBufferedSourceRecovery', 'completeBufferedSourceRecovery', 'prepareBufferedSourceRecovery'];
  const code = ast.instance.content.body.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name)).map(node => source.slice(node.start, node.end)).join('\n');
  let tick, fallbacks = 0;
  const state = {
    playback: { id: 'movie', hlsUrl: '/api/play/movie/hls' },
    player: { currentTime: 12, paused: false, buffered: { length: 1, start: () => 0, end: () => 30 } },
    resumeStreamOffset: 100, streamAttempt: 0, pendingBufferedRecovery: null, buffering: false,
    bufferedRecoveryTarget, readPlaybackSetup, AbortSignal, AbortController,
    playbackTrace: { event() {} }, interpolationDisabled: false,
    currentPlaybackPosition: () => state.player.currentTime + 100,
    setInterval: callback => { tick = callback; return 1; }, clearInterval() {},
    fetch: async () => ({ ok: false, headers: { get: () => 'application/json' }, json: async () => ({ error: 'No source', code: 'SOURCE_UNAVAILABLE' }) }),
    restartStream: () => assert.fail('The failed source must not restart'),
    fallback: () => { fallbacks++; }, handlePlaybackInterruption() {}
  };
  runInNewContext(code, state);
  state.prepareBufferedSourceRecovery();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fallbacks, 0);
  state.player.currentTime = 29.1;
  tick();
  assert.equal(fallbacks, 1);
});

test('leaving before handoff releases the unused replacement session', async () => {
  const node = ast.instance.content.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'clearBufferedSourceRecovery');
  const requests = [], controller = new AbortController();
  const state = {
    pendingBufferedRecovery: { controller, timer: 1, session: { sessionUrl: '/unused' } },
    clearInterval() {}, fetch: async url => { requests.push(url); return { ok: true }; }
  };
  runInNewContext(source.slice(node.start, node.end), state);
  state.clearBufferedSourceRecovery();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(requests, ['/unused/stop']);
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

test('a downloaded copy retries a transient stall at the same playhead', () => {
  const { state, requests } = recoveryState();
  state.playback.mode = 'cached';
  state.resumeStreamOffset = 0;
  state.player.currentTime = 140;
  state.handlePlaybackInterruption('buffering-timeout', 'No advancing frames');
  assert.equal(state.restartedAt, 140);
  assert.equal(state.automaticStreamRetries, 1);
  assert.equal(requests.length, 0);
});

test('reloading a downloaded copy restores the saved playhead after metadata arrives', () => {
  const { state } = recoveryState();
  state.playback.mode = 'cached';
  state.resumeStreamOffset = 0;
  state.player.currentTime = 140;
  state.bufferedRanges = [];
  state.streamAttempt = 0;
  state.playbackTrace = { event() {} };
  runInNewContext(restartHandler, state);

  state.restartStream(140);
  assert.equal(state.recoveryPosition, 140);
  assert.equal(state.resumeStreamOffset, 0);
  assert.equal(state.streamAttempt, 1);

  state.player.currentTime = 0;
  state.restorePlaybackProgress();
  assert.equal(state.player.currentTime, 140);
});

test('recovery choices cover direct, converting, and downloaded playback', () => {
  for (const [mode, reason, retries, expected] of [
    ['direct', 'buffering-timeout', 0, 'retry'],
    ['direct', 'buffering-timeout', 3, 'offer'],
    ['cached-convert', 'buffering-timeout', 0, 'retry'],
    ['cached-convert', 'buffering-timeout', 3, 'error'],
    ['cached', 'buffering-timeout', 0, 'retry'],
    ['cached', 'buffering-timeout', 3, 'error'],
    ['cached', 'media-error', 0, 'error']
  ]) {
    assert.equal(streamInterruptionAction({ mode, status: 'ready' }, retries, 3, reason), expected, `${mode} ${reason} after ${retries} retries`);
  }
});

test('an exhausted downloaded copy offers a local retry without re-downloading', () => {
  const { state, requests } = recoveryState(3);
  state.playback.mode = 'cached';
  state.resumeStreamOffset = 0;
  state.player.currentTime = 140;
  state.handlePlaybackInterruption('buffering-timeout', 'The video stopped making progress.');
  assert.equal(state.playback.status, 'ready');
  assert.equal(state.playbackRecovery?.cached, true);
  assert.equal(state.playbackRecovery?.position, 140);
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

test('an interpolation buffering timeout downgrades once instead of repeating the expensive conversion', () => {
  const { state } = recoveryState();
  state.playback.frameInterpolation = true;
  state.interpolationDisabled = false;
  state.playerControlError = '';
  state.handlePlaybackInterruption('buffering-timeout', 'No advancing frames.');
  assert.equal(state.interpolationDisabled, true);
  assert.equal(state.restartedAt, 140);
  assert.equal(state.automaticStreamRetries, 0);
  assert.match(state.playerControlError, /original frame rate/i);
  state.handlePlaybackInterruption('buffering-timeout', 'Still stalled.');
  assert.equal(state.automaticStreamRetries, 1, 'ordinary recovery remains bounded after interpolation is disabled');
});
