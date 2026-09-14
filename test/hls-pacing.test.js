import test from 'node:test';
import assert from 'node:assert/strict';
import { createHlsPacing } from '../src/lib/server/hls-pacing.js';

test('detects startup-burst support once across concurrent playback requests', async () => {
  let reads = 0;
  const pacing = createHlsPacing(async () => { reads++; return '-readrate_initial_burst <seconds>'; });
  const [first, second] = await Promise.all([pacing(), pacing()]);
  assert.deepEqual(first, ['-readrate', '1.5', '-readrate_initial_burst', '8']);
  first.push('mutated');
  assert.deepEqual(await pacing(), second);
  assert.equal(reads, 1);
});

test('older FFmpeg and failed capability checks preserve the existing pacing', async () => {
  for (const help of [async () => '-readrate <speed>', async () => { throw new Error('unavailable'); }]) {
    const pacing = createHlsPacing(help);
    assert.deepEqual(await pacing(), ['-readrate', '1.5']);
    assert.deepEqual(await pacing(110.900803), ['-readrate', '1.5']);
  }
});

test('discarded input gets its own startup allowance without changing other sessions', async () => {
  const pacing = createHlsPacing(async () => '-readrate_initial_burst <seconds>');
  const [resume, beginning] = await Promise.all([pacing(110.900803), pacing()]);
  assert.deepEqual(resume, ['-readrate', '1.5', '-readrate_initial_burst', '118.900803']);
  assert.deepEqual(beginning, ['-readrate', '1.5', '-readrate_initial_burst', '8']);
  for (const offset of [0, -1, NaN, Infinity, '110']) {
    assert.deepEqual(await pacing(offset), beginning);
  }
});
