import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameTimingCollector, frameTiming } from '../src/lib/frame-timing.js';

test('distinguishes presentation gaps from steady source timing', () => {
  const collector = createFrameTimingCollector();
  let display = 0;
  for (let frame = 0; frame < 30; frame++) {
    display += frame === 20 ? 160 : 40;
    collector.add(display - 5, { expectedDisplayTime: display, mediaTime: frame * .04, presentedFrames: frame });
  }
  const stats = collector.summary();
  assert.equal(stats.sourceMedianMs, 40);
  assert.ok(Math.abs(stats.sourceMaxMs - 40) < .001);
  assert.equal(stats.displayMaxMs, 160);
  assert.equal(stats.longDisplayIntervals, 1);
  assert.equal(stats.callbackLateMaxMs, 0);
});

test('missed callbacks and late observers do not imply dropped video frames', () => {
  const collector = createFrameTimingCollector();
  collector.add(0, { expectedDisplayTime: 0, mediaTime: 0, presentedFrames: 1 });
  collector.add(170, { expectedDisplayTime: 120, mediaTime: .12, presentedFrames: 4 });
  const stats = collector.summary();
  assert.equal(stats.skippedCallbacks, 2);
  assert.equal(stats.samples, 0);
  assert.equal(stats.longDisplayIntervals, 0);
  assert.equal(stats.callbackLateMaxMs, 50);
  collector.breakSequence();
  collector.add(10000, { expectedDisplayTime: 10000, mediaTime: 1, presentedFrames: 5 });
  collector.add(10040, { expectedDisplayTime: 10040, mediaTime: 1.04, presentedFrames: 6 });
  assert.equal(collector.summary().displayMaxMs, 40);
});

test('timing records stay bounded and reset with a new source', () => {
  const collector = createFrameTimingCollector();
  for (let frame = 0; frame < 5000; frame++) collector.add(frame * 10, { expectedDisplayTime: frame * 10, mediaTime: frame * .01, presentedFrames: frame });
  assert.ok(collector.summary().samples <= 600);
  assert.equal(collector.summary().intervals.length, 60);
  collector.reset();
  assert.equal(collector.summary().samples, 0);
  assert.equal(collector.summary().displayMedianMs, null);
});

test('observer cancels callbacks on pause, visibility changes and teardown', () => {
  const doc = new EventTarget(); doc.hidden = false;
  const video = new EventTarget(); video.ownerDocument = doc; video.paused = false; video.seeking = false;
  let next = 0; const scheduled = new Map();
  video.requestVideoFrameCallback = callback => { scheduled.set(++next, callback); return next; };
  video.cancelVideoFrameCallback = id => scheduled.delete(id);
  const states = [];
  const observer = frameTiming(video, { key: 'a', onSample: stats => states.push(stats.state) });
  assert.equal(scheduled.size, 1);
  video.paused = true; video.dispatchEvent(new Event('pause'));
  assert.equal(scheduled.size, 0);
  assert.equal(states.at(-1), 'paused');
  video.paused = false; video.dispatchEvent(new Event('playing'));
  assert.equal(scheduled.size, 1);
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(scheduled.size, 0);
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(scheduled.size, 1);
  observer.destroy();
  assert.equal(scheduled.size, 0);
  video.dispatchEvent(new Event('playing'));
  assert.equal(scheduled.size, 0);
});


test('source timestamp jumps are visible independently of display cadence', () => {
  const collector = createFrameTimingCollector();
  collector.add(0, { expectedDisplayTime: 0, mediaTime: 0, presentedFrames: 1 });
  collector.add(40, { expectedDisplayTime: 40, mediaTime: .04, presentedFrames: 2 });
  collector.add(80, { expectedDisplayTime: 80, mediaTime: .2, presentedFrames: 3 });
  assert.equal(collector.summary().displayMaxMs, 40);
  assert.equal(collector.summary().sourceMaxMs, 160);
});

test('old frame intervals expire from the ten-second window', () => {
  const collector = createFrameTimingCollector();
  collector.add(0, { expectedDisplayTime: 0, mediaTime: 0, presentedFrames: 1 });
  collector.add(40, { expectedDisplayTime: 40, mediaTime: .04, presentedFrames: 2 });
  collector.breakSequence();
  collector.add(11000, { expectedDisplayTime: 11000, mediaTime: 11, presentedFrames: 3 });
  collector.add(11040, { expectedDisplayTime: 11040, mediaTime: 11.04, presentedFrames: 4 });
  assert.equal(collector.summary().samples, 1);
});
