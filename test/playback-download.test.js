import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackDownloadProgress, playbackPreparationStage } from '../src/lib/playback-download.js';

test('full-download percentage measures the transfer rather than overall preparation', () => {
  assert.deepEqual(playbackDownloadProgress({ completedSegments: 50, totalSegments: 100,
    bytes: 1024 ** 3, bytesPerSecond: 10 * 1024 ** 2, remainingSeconds: 90 }), {
    percent: 50, detail: '1.0 GB downloaded · 10.0 MB/s · about 2 min left'
  });
  assert.equal(playbackDownloadProgress({ completedSegments: 100, totalSegments: 100 }).percent, 100);
});

test('unknown and zero progress remain honest without a fictitious ETA', () => {
  assert.deepEqual(playbackDownloadProgress(null), { percent: null, detail: '0 B downloaded · Measuring speed…' });
  assert.equal(playbackDownloadProgress({ completedSegments: 0, totalSegments: 100 }).percent, 0);
  assert.equal(playbackDownloadProgress({ totalSegments: 0 }).percent, null);
  assert.equal(playbackDownloadProgress({ completedSegments: 200, totalSegments: 100 }).percent, 100);
  assert.equal(playbackDownloadProgress({ totalSegments: Infinity }).percent, null);
});

test('post-download stages explain the remaining work without reporting another download', () => {
  assert.equal(playbackPreparationStage('downloading').title, 'Downloading video');
  assert.equal(playbackPreparationStage('extracting').title, 'Unpacking video');
  assert.equal(playbackPreparationStage('optimizing').title, 'Preparing video');
  assert.equal(playbackPreparationStage('ready'), null);
  assert.equal(playbackPreparationStage('error'), null);
});
