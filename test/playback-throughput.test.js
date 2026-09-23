import test from 'node:test';
import assert from 'node:assert/strict';
import { createArticleDeliveryMeter, createVideoOutputMeter } from '../src/lib/server/playback-throughput.js';

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
