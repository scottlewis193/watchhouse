import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';

// Run the actual page handlers with controlled media events and timers.
const source = await readFile(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const ast = parse(source);
const names = ['handlePause', 'handleStartupBuffering', 'attemptAutomaticPlayback', 'refreshDiagnostics', 'handleTimeUpdate'];
const handlers = ast.instance.content.body.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name)).map(node => source.slice(node.start, node.end)).join('\n');
function playerState() {
  const timers = new Map(); let next = 0;
  const state = {
    player: { paused: false, play: async () => { state.plays++; } },
    plays: 0, interruptions: 0, playing: true, playbackSettled: true,
    playback: { mode: 'direct', status: 'ready' }, playbackNeedsAction: false, playbackRecovery: null,
    continuePlaybackOnReady: false, resumeStarting: false,
    interruptionTimer: null, startupStableTimer: null, controlHideTimer: null,
    controlsVisible: false, stopBackgroundPlayback() {}, captureVideoDiagnostics() {},
    savePlaybackProgress: async () => {}, controlTimeline: () => ({ position: 111 }), currentPlaybackPosition: () => 111,
    handlePlaybackInterruption: () => { state.interruptions++; },
    settlePlaybackWarmup() {},
    setTimeout: callback => { timers.set(++next, callback); return next; },
    clearTimeout: id => timers.delete(id)
  };
  Object.assign(state, { seekPaused: false, seekTimer: null, buffering: false, statusFailures: 0, lastAdvancedPosition: 0, lastDiagnosticAt: 0, AbortSignal, playbackTrace: { event() {} }, traceSource: () => 'fixture', firstAdvancedSource: '' });
  runInNewContext(handlers, state);
  return { state, timers };
}

test('a stalled event after pause does not restart the stream as a seek', () => {
  const { state, timers } = playerState();
  state.player.paused = true;
  state.handlePause();
  state.handleStartupBuffering({ type: 'stalled' });
  for (const callback of timers.values()) callback();
  assert.equal(state.interruptions, 0);
});

test('a pending buffering timeout checks whether playback has since paused', () => {
  const { state, timers } = playerState();
  state.handleStartupBuffering({ type: 'waiting' });
  state.player.paused = true;
  for (const callback of timers.values()) callback();
  assert.equal(state.interruptions, 0);
});

test('canplay after established playback does not undo pause', async () => {
  const { state } = playerState();
  state.player.paused = true;
  state.handlePause();
  await state.attemptAutomaticPlayback();
  assert.equal(state.plays, 0);
});

test('initial autoplay and recovery from a real playback stall still work', async () => {
  const { state, timers } = playerState();
  state.handleStartupBuffering({ type: 'waiting' });
  for (const callback of timers.values()) callback();
  assert.equal(state.interruptions, 1);
  state.playbackSettled = false;
  state.player.paused = true;
  await state.attemptAutomaticPlayback();
  assert.equal(state.plays, 1);
});


test('server fallback leaves stale ready playback and follows download progress', async () => {
  const { state } = playerState();
  state.playback.id = 'job';
  state.playbackRequests = { isCurrent: () => true };
  state.api = { get: async () => ({ id: 'job', status: 'downloading', message: 'Downloading archive', diagnostics: {} }) };
  state.currentPlaybackPosition = () => 318;
  state.recoveryPosition = 0;
  state.resumePlayback = false;
  state.diagnosticPollTimer = null;
  const polls = [];
  state.poll = (...args) => polls.push(args);
  await state.refreshDiagnostics('job', 1);
  assert.equal(state.playback.status, 'downloading');
  assert.equal(state.recoveryPosition, 318);
  assert.equal(state.continuePlaybackOnReady, true, 'server-side fallback must retain autoplay intent');
  assert.deepEqual(polls, [['job', 1, 0]]);
});


test('a transient status failure schedules another check for the same job', async () => {
  const { state, timers } = playerState();
  state.playback.id = 'job';
  state.playbackRequests = { isCurrent: () => true };
  state.api = { get: async () => { throw new Error('Temporary connection loss'); } };
  await state.refreshDiagnostics('job', 1);
  assert.equal(timers.size, 1);
  assert.equal(state.playback.status, 'ready', 'keep the established player');
});

test('stationary timeupdate does not cancel the buffering watchdog; advancing time does', () => {
  const {state,timers}=playerState(); let position=111;
  Object.assign(state, {currentPlaybackPosition:()=>position, updateBufferedRanges(){}, restorePlaybackProgress(){}, monitorAudioPlayback(){}, shouldShowUpNext:()=>false, autoPlayNext:false, nextMedia:null, sampleForEndCredits(){}, prepareNextEpisode(){}, playerPosition:0, playerDuration:0, currentMedia:{}, currentPlaybackRequestToken:1});
  state.handleStartupBuffering({type:'waiting'});
  state.handleTimeUpdate();
  assert.equal(timers.size,1);
  position=112; state.handleTimeUpdate();
  assert.equal(timers.size,0);
});
test('repeated waiting events do not postpone recovery and cached conversion has a watchdog', () => {
  const {state,timers}=playerState(); state.playback.mode='cached-convert';
  state.handleStartupBuffering({type:'waiting'}); const id=state.interruptionTimer;
  state.handleStartupBuffering({type:'waiting'});
  assert.equal(state.interruptionTimer,id); assert.equal(timers.size,1);
  for (const callback of timers.values()) callback();
  assert.equal(state.interruptions,1);
});

test('a downloaded copy that stops advancing gets a buffering watchdog', () => {
  const { state, timers } = playerState();
  state.playback.mode = 'cached';
  state.handleStartupBuffering({ type: 'waiting' });
  assert.equal(timers.size, 1);
  for (const callback of timers.values()) callback();
  assert.equal(state.interruptions, 1);
});
