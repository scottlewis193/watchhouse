import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpegArgs, inspectPlaybackSource, playbackTimelineHasGap, validateOfflinePlaybackRecord } from '../src/lib/server/streamer.js';

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

test('a video-only timeline hole is rejected when audio continues through it', () => {
  const packets = [
    { stream_index: 0, dts_time: '7.960000' },
    { stream_index: 7, dts_time: '8.000000' },
    { stream_index: 7, dts_time: '8.500000' },
    { stream_index: 7, dts_time: '9.000000' },
    { stream_index: 0, dts_time: '9.440000' },
    { stream_index: 7, dts_time: '9.500000' }
  ];
  assert.equal(playbackTimelineHasGap(packets, 0, 7), true);
});

test('startup inspection rejects a shared ten-second timeline hole before HLS playback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchhouse-timeline-'));
  try {
    for (const gap of ['none', 'audio-only', 'video-only', 'both']) {
      const path = join(root, `${gap}.mkv`);
      await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=14',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=14',
        ...(['video-only', 'both'].includes(gap) ? ['-vf', "select='not(between(t,2,12))'"] : []),
        ...(['audio-only', 'both'].includes(gap) ? ['-af', "aselect='not(between(t,2,12))'"] : []),
        '-fps_mode', 'vfr', '-c:v', 'libx264', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', path]);
      if (['video-only', 'both'].includes(gap)) await assert.rejects(inspectPlaybackSource(path), { code: 'INVALID_MEDIA_TIMELINE' });
      else {
        const metadata = await inspectPlaybackSource(path);
        assert.equal(metadata.audioIndex, 1);
        assert.ok(metadata.duration >= 14);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('downloaded media can validate the full timeline instead of only its opening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchhouse-late-timeline-'));
  try {
    const path = join(root, 'late-video-gap.mkv');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=26',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=26', '-vf', "select='not(between(t,22,24))'",
      '-fps_mode', 'vfr', '-c:v', 'libx264', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', path]);
    await assert.doesNotReject(inspectPlaybackSource(path));
    await assert.rejects(inspectPlaybackSource(path, 2, { fullTimeline: true }), { code: 'INVALID_MEDIA_TIMELINE' });
    const repair = await inspectPlaybackSource(path, 2, { fullTimeline: true, repairVideoTimeline: true });
    assert.equal(repair.repairVideoFrameRate, 25);
    const repaired = join(root, 'repaired.mp4');
    await run('ffmpeg', ffmpegArgs('transcode', path, repaired, false, 0, 2, false, false, null, repair.repairVideoFrameRate));
    await assert.doesNotReject(inspectPlaybackSource(repaired, 2, { fullTimeline: true }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy offline records receive one full validation before reuse', async () => {
  const calls = [];
  const record = { key: 'episode', sourcePath: '/saved/episode.mkv', status: 'ready' };
  const validated = await validateOfflinePlaybackRecord(record, { untaggedAudioTrack: 3 }, async (...args) => { calls.push(args); });
  assert.equal(validated.timelineValidated, true);
  assert.deepEqual(calls, [['/saved/episode.mkv', 3, { fullTimeline: true }]]);
  assert.equal(await validateOfflinePlaybackRecord(validated, {}, assert.fail), validated);
});

test('legacy offline records request repair without being marked validated first', async () => {
  const record = { key: 'episode', path: '/saved/episode.mkv', status: 'ready' };
  const result = await validateOfflinePlaybackRecord(record, { repairVideoTimeline: true }, async (_path, _track, options) => {
    assert.deepEqual(options, { fullTimeline: true, repairVideoTimeline: true });
    return { repairVideoFrameRate: 25 };
  });
  assert.equal(result.timelineValidated, undefined);
  assert.equal(result.timelineRepairRequired, true);
  assert.equal(result.repairVideoFrameRate, 25);
});
