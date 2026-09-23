import test from 'node:test';
import assert from 'node:assert/strict';
import { createArticleDeliveryMeter, createVideoOutputMeter, createVideoTimelineGuard } from '../src/lib/server/playback-throughput.js';

test('article delivery excludes the first connection and reports completed bodies over time', () => {
  let time = 0;
  const samples = [];
  const meter = createArticleDeliveryMeter(sample => samples.push(sample), { now: () => time, intervalMs: 3000 });
  meter.record(1_000_000);
  time = 1500; meter.record(1_000_000);
  time = 3000; meter.record(1_000_000);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].bytes, 2_000_000);
  assert.equal(samples[0].articles, 2);
  assert.equal(samples[0].bytesPerSecond, 2_000_000 / 3);
});

test('an idle gap does not turn a later article into an artificial slow sample', () => {
  let time = 0;
  const samples = [];
  const meter = createArticleDeliveryMeter(sample => samples.push(sample), { now: () => time });
  meter.record(1_000_000);
  time = 2000; meter.record(1_000_000);
  time = 20000; meter.record(1_000_000);
  meter.flush();
  assert.equal(samples.length, 0);
});

test('video output measures produced seconds separately and resets when paused', () => {
  let time = 0;
  const samples = [];
  const meter = createVideoOutputMeter(sample => samples.push(sample), { now: () => time });
  meter.record(2);
  time = 10000; meter.record(17);
  assert.equal(samples[0].viewingSpeed, 1.5);
  meter.record(17, true);
  time = 20000; meter.record(17);
  time = 30000; meter.record(22);
  assert.equal(samples[1].viewingSpeed, 0.5);
});

test('large time jumps without matching video frames are rejected', () => {
  const guard = createVideoTimelineGuard({ frameRate: 24 });
  assert.equal(guard.record(1, 0), null);
  assert.equal(guard.record(241, 10), null);
  assert.deepEqual(guard.record(250, 135), { elapsedSeconds: 125, frames: 9 });
  assert.deepEqual(createVideoTimelineGuard({ frameRate: 24 }).record(9, 125), { elapsedSeconds: 125, frames: 9 });
});

test('fast continuous conversion and a seek origin do not look like timeline gaps', () => {
  const fast = createVideoTimelineGuard({ frameRate: 24 });
  assert.equal(fast.record(1, 0), null);
  assert.equal(fast.record(3001, 125), null);
  const resumed = createVideoTimelineGuard({ frameRate: 24, start: 125 });
  assert.equal(resumed.record(1, 125), null);
  assert.equal(resumed.record(241, 135), null);
});
