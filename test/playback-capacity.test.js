import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateNeedsMoreSpeed, candidatePlaybackDemand, createProviderSpeedMeter } from '../src/lib/server/playback-capacity.js';

test('recent provider speed is reused conservatively and expires', () => {
  let time = 0;
  const meter = createProviderSpeedMeter({ now: () => time });
  const settings = { usenetHost: 'provider', usenetUser: 'viewer', maxConnections: 4 };
  meter.record(settings, 1024 * 1024, 1000);
  assert.equal(meter.rate(settings), 1024 * 1024);
  meter.record(settings, 1024 * 1024, 2000);
  assert.equal(meter.rate(settings), 512 * 1024);
  meter.record(settings, 1024 * 1024, 500);
  assert.equal(meter.rate(settings), 512 * 1024);
  assert.equal(meter.rate({ ...settings, usenetUser: 'other' }), null);
  time += 10 * 60 * 1000;
  assert.equal(meter.rate(settings), null);
});

test('release size and duration are only a conservative speed screen', () => {
  const file = { segments: [{ decodedBytes: 6_000_000 }, { decodedBytes: 6_000_000 }] };
  assert.equal(candidatePlaybackDemand(file, 60), 300_000);
  assert.equal(candidateNeedsMoreSpeed(file, 60, 250_000), true);
  assert.equal(candidateNeedsMoreSpeed(file, 60, 400_000), false);
  assert.equal(candidatePlaybackDemand(file, 0), null);
  assert.equal(candidateNeedsMoreSpeed(file, 0, 10), false);
});
