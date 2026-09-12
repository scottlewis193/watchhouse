import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectPlaybackSource, playbackTimelineHasGap } from '../src/lib/server/streamer.js';

const run = promisify(execFile);

test('a demuxer-inferred long frame duration does not conceal the real episode gap', () => {
  const packets = [
    { stream_index: 0, dts_time: '7.925000', duration_time: '10.042000' },
    { stream_index: 0, dts_time: '7.966000', duration_time: '0.041000' },
    { stream_index: 7, dts_time: '8.000000', duration_time: '0.032000' },
    { stream_index: 0, dts_time: '18.008000', duration_time: '0.041000' },
    { stream_index: 7, dts_time: '18.032000', duration_time: '0.032000' }
  ];
  assert.equal(playbackTimelineHasGap(packets, 0, 7), true);
});

test('startup inspection rejects a shared ten-second timeline hole before HLS playback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchhouse-timeline-'));
  try {
    for (const gap of ['none', 'audio-only', 'both']) {
      const path = join(root, `${gap}.mkv`);
      await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=14',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=14',
        ...(gap === 'both' ? ['-vf', "select='not(between(t,2,12))'"] : []),
        ...(gap !== 'none' ? ['-af', "aselect='not(between(t,2,12))'"] : []),
        '-fps_mode', 'vfr', '-c:v', 'libx264', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', path]);
      if (gap === 'both') await assert.rejects(inspectPlaybackSource(path), { code: 'INVALID_MEDIA_TIMELINE' });
      else {
        const metadata = await inspectPlaybackSource(path);
        assert.equal(metadata.audioIndex, 1);
        assert.ok(metadata.duration >= 14);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
