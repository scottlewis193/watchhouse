import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import * as controls from '../src/lib/playback-controls.js';
import { assertCompleteEpisodeDuration, startHlsConversion } from '../src/lib/server/streamer.js';

const source = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const ast = parse(source);
const handlers = ast.instance.content.body.filter(node => node.type === 'FunctionDeclaration' && ['controlTimeline', 'handleEnded'].includes(node.id.name)).map(node => source.slice(node.start, node.end)).join('\n');
function partialEpisode(sourceDuration = 71) {
  const state = {
    ...controls, sourceDuration, playerPosition: 71, playerDuration: 71,
    resumeStreamOffset: 0, seekPreview: null, playing: true,
    playback: { status: 'ready', mode: 'direct' }, player: { currentTime: 71 },
    currentMedia: { type: 'tv', season: 2, episode: 5, durationHint: 22 * 60 },
    progressFor: () => ({ duration: 71 }), captureVideoDiagnostics() {},
    downloadNextEpisode: false, autoPlayNext: true,
    nextMedia: { type: 'tv', season: 2, episode: 6 }, nextJob: { status: 'ready' },
    recovered: 0, advanced: 0, marked: 0,
    handlePlaybackInterruption() { state.recovered++; },
    beginUpNextCountdown() { state.advanced++; },
    setWatched() { state.marked++; }, savePlaybackProgress() {},
    currentPlaybackPosition: () => state.playerPosition,
    startPlayback() { state.advanced++; }, playAdjacentEpisode() { state.advanced++; }
  };
  runInNewContext(handlers, state);
  return state;
}

test('S02E05 partial source duration does not replace the catalogue runtime', () => {
  const state = partialEpisode();
  assert.equal(state.controlTimeline().duration, 1320, 'the 1:11 fragment is not a full episode');
  assert.equal(controls.shouldSampleForCredits(71, state.controlTimeline().duration), false);
});

test('ending a 1:11 fragment recovers the same episode instead of advancing', () => {
  const state = partialEpisode(1320);
  state.handleEnded();
  assert.equal(state.recovered, 1, 'premature EOF must enter automatic recovery');
  assert.equal(state.advanced, 0);
  assert.equal(state.marked, 0);
});

test('a genuine episode end still advances normally', () => {
  const state = partialEpisode(1320);
  state.playerPosition = state.playerDuration = state.player.currentTime = 1320;
  state.handleEnded();
  assert.equal(state.recovered, 0);
  assert.equal(state.advanced, 1);
});

test('prepared fragments cannot be accepted as complete episodes', () => {
  assert.throws(() => assertCompleteEpisodeDuration(71, 1320), { code: 'INVALID_MEDIA_DURATION' });
  assert.doesNotThrow(() => assertCompleteEpisodeDuration(1295, 1320));
  assert.doesNotThrow(() => assertCompleteEpisodeDuration(1295, 0));
});

test('the HLS pipeline rejects short episode metadata before starting a converter', async () => {
  let started = false;
  const job = { mode: 'cached-convert', strategy: 'remux', release: 'SDR', sourcePath: '/unused-episode-source', media: { type: 'tv', durationHint: 1320 } };
  await assert.rejects(startHlsConversion(job, {}, 0, '/unused-episode-output', () => { started = true; }, async () => [], () => ({
    metadata: Promise.resolve({ audioIndex: null, duration: 71 }), validated: Promise.resolve()
  })), { code: 'INVALID_MEDIA_DURATION' });
  assert.equal(started, false, 'no incomplete playlist may be delivered');
});

test('duration resolution retains precise normal source runtimes and ignores invalid values', () => {
  assert.equal(controls.resolvedMediaDuration(1295, 1320, 71), 1295);
  assert.equal(controls.resolvedMediaDuration(0, 1320, 71), 1320);
  assert.equal(controls.resolvedMediaDuration(NaN, 0, 1320), 1320);
  assert.equal(controls.resolvedMediaDuration(-1, Infinity, -1), 0);
});
