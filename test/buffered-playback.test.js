import test from 'node:test';
import assert from 'node:assert/strict';
import { bufferedPlaybackRanges } from '../src/lib/playback-controls.js';

test('buffer overlay preserves gaps and accounts for resumed streaming timelines', () => {
  const ranges = [{ start: 0, end: 100 }, { start: 200, end: 300 }];
  for (const mode of ['direct', 'cached-convert']) {
    assert.deepEqual(bufferedPlaybackRanges(mode, ranges, 1000, 500), [
      { left: 50, width: 10 }, { left: 70, width: 10 }
    ]);
  }
  assert.deepEqual(bufferedPlaybackRanges('cached', ranges, 1000, 500), [
    { left: 0, width: 10 }, { left: 20, width: 10 }
  ]);
});

test('buffer overlay clips to the timeline and ignores unknown duration or invalid ranges', () => {
  assert.deepEqual(bufferedPlaybackRanges('direct', [{ start: 0, end: 500 }], 1000, 900), [{ left: 90, width: 10 }]);
  for (const duration of [0, NaN, Infinity]) {
    assert.deepEqual(bufferedPlaybackRanges('direct', [{ start: 0, end: 100 }], duration), []);
  }
  assert.deepEqual(bufferedPlaybackRanges('direct', [], 1000), []);
  assert.deepEqual(bufferedPlaybackRanges('direct', [{ start: NaN, end: 10 }, { start: 20, end: 10 }, { start: 1000, end: 1200 }], 1000), []);
});
