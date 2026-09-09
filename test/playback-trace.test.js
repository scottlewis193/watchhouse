import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackTrace, playbackTraceSample } from '../src/lib/playback-trace.js';

test('captures buffer gaps, resumed position and browser error before restarting', () => {
  const player = { currentTime: 15, duration: Infinity, buffered: { length: 2, start: i => [0, 20][i], end: i => [10, 30][i] }, error: { code: 3 }, webkitAudioDecodedByteCount: 400 };
  const sample = playbackTraceSample(player, 100, 1000);
  assert.equal(sample.position, 115);
  assert.equal(sample.bufferedAhead, 0);
  assert.equal(sample.duration, null);
  assert.equal(sample.errorCode, 3);
  assert.equal(sample.videoFrames, null);
  player.currentTime = 25;
  assert.equal(playbackTraceSample(player).bufferedAhead, 5);
  assert.equal(sample.currentTime, 15);
});

test('retains restart evidence when the media element and source are replaced', () => {
  const trace = createPlaybackTrace();
  const before = { at: 1000, currentTime: 30, audioDecodedBytes: 1234 };
  trace.sample('job:0', before);
  before.currentTime = 0;
  const events = trace.interrupt('job:0', { reason: 'buffering-timeout', action: 'retry', attempt: 1 }, { at: 11000, currentTime: 30 });
  assert.equal(events[0].samples[0].currentTime, 30);
  events[0].samples[0].audioDecodedBytes = 0;
  trace.sample('job:1', { at: 12000, currentTime: 0 });
  const next = trace.interrupt('job:1', { reason: 'media-error', action: 'offer' }, { at: 13000, currentTime: 0 });
  assert.equal(next[0].samples[0].audioDecodedBytes, 1234);
  assert.equal(next[1].samples.length, 1);
  assert.equal(next[0].reason, 'buffering-timeout');
});

test('bounds sampling and interruption history during repeated retries', () => {
  const trace = createPlaybackTrace();
  for (let at = 0; at < 40000; at += 100) trace.sample('job:0', { at });
  let events;
  for (let i = 0; i < 25; i++) events = trace.interrupt('job:0', { attempt: i }, { at: 40000 + i });
  assert.equal(events.length, 20);
  assert.equal(events[0].attempt, 5);
  assert.equal(events[0].samples.length, 30);
  assert.equal(events[0].samples[0].at, 10000);
});
